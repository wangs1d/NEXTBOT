import {
  createContentSummary,
  formatContentSummaryForChat,
  formatContentSummaryForPlainText,
  shouldSummarizeContent,
} from "../services/content-summary-service.js";
import { routeRender } from "../gateway/index.js";
import { extractDataBriefPayload } from "./render-hint-service.js";
import {
  formatAgentResultForChat,
} from "./agent-result-formatter.js";
import { hasBlockquote } from "./display-effect-router.js";
import { tryAttachToolResultCard } from "./tool-card-registry.js";
import { travelItineraryStore } from "../skills/travel-planning/travel-itinerary-store.js";
import { travelPlanStore } from "../skills/travel-planning/travel-plan-store.js";
import type { InfoSearchItem } from "./info-hub-service.js";
import {
  hasInternalFrameTag,
  isInternalFrameText,
  isSystemFrameText,
  stripInternalFrames,
} from "../external-model/internal-frames.js";

/** 摘要折叠字数阈值（与 content-summary-service / render-hint-service 保持一致：400） */
const CONTENT_LENGTH_THRESHOLD = 400;

/** 提取 LLM 输出的 [RENDER_HINT:xxx] 标记，剥离后返回 hint 和清洗后的文本 */
function extractLlmRenderHint(text: string): { rawHint: string | null; cleanText: string } {
  const match = text.trimStart().match(/^\[RENDER_HINT:(\w+)\]\s*/);
  if (!match) return { rawHint: null, cleanText: text };
  return { rawHint: match[1], cleanText: text.slice(match[0].length).trim() };
}

/** 注入前端 [RENDER_AS:xxx] 标记 */
function wrapRenderAs(name: string, text: string): string {
  return `[RENDER_AS:${name}]\n${text}`;
}

/** 模型复述在正文里的展示形态声明（RENDER_AS / RENDER_HINT，任意位置）。
 *  2026-10-11 扩容：模型会把格式写歪成 `[RENDER_HINT]:brief`（括号在冒号前闭合，
 *  实机探针实证透进气泡）——容错匹配规范形与变体形。 */
const RENDER_DECLARATION_TOKEN_RE = /\[RENDER_(?:HINT|AS)\]?\s*[:：]\s*[A-Za-z_]+\]?/g;

/**
 * 剥掉正文任何位置残留的 [RENDER_AS:xxx] / [RENDER_HINT:xxx] 声明。
 * extractLlmRenderHint 只认文本开头一处 RENDER_HINT；模型照抄历史消息格式
 * 把声明复述在中段/结尾时（真实案例：行程攻略结尾带 [RENDER_AS:structured]），
 * 客户端只剥开头一处权威标记，残留声明会被当字面文本渲染在卡片下方。
 * 声明只属于路由信号，权威标记由 wrapRenderAs 统一前置注入。
 */
export function stripResidualRenderDeclarations(text: string): string {
  if (!text.includes("[RENDER_")) return text;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.replace(RENDER_DECLARATION_TOKEN_RE, "");
    // 声明独占一行 → 整行删除；行内嵌声明 → 就地剥离，保留其余文本
    if (!stripped.trim() && line.trim()) continue;
    kept.push(stripped);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const CARD_MARKER_START = "[AGENT_RESULT_CARD_START]";
const CARD_MARKER_END = "[AGENT_RESULT_CARD_END]";

/** 模型卡片块允许透传的条目级字段（其余字段一律剥掉，防止脏数据透出） */
const MODEL_CARD_ITEM_FIELDS = [
  "url", "side", "sideLabel", "source", "thumbnailUrl", "mediaUrl", "pageUrl", "caption",
] as const;

/**
 * 校验/归一化模型自声明的卡片块（渲染管线 L2 的服务端验收关卡）。
 *
 * L2 激活后（render-protocol-prompt 注入），模型会在正文里直接输出
 * [AGENT_RESULT_CARD_START]{...}[END] 卡片块。模型输出不可信：
 *   - JSON 解析失败 / 缺 title / items 为空 → 整块丢弃（残缺块同样丢弃，
 *     防止半截 JSON 透出前端）；
 *   - 合法块 → 补齐 avatar/cardId/actions 等默认字段、条目字段白名单过滤、
 *     条目数截到 12，重建为标准 payload（与 formatAgentResultForChat 产物同构）。
 *
 * 纯文本/服务端生成的块（已带 cardId）经此函数幂等不变（重新序列化语义相同）。
 */
export function sanitizeModelCardBlocks(text: string): string {
  if (!text.includes(CARD_MARKER_START)) return text;
  let out = "";
  let rest = text;
  for (let guard = 0; guard < 20; guard++) {
    const si = rest.indexOf(CARD_MARKER_START);
    if (si === -1) break;
    const ei = rest.indexOf(CARD_MARKER_END, si + CARD_MARKER_START.length);
    const before = rest.slice(0, si);
    if (ei === -1) {
      // 残缺块（无 END）：整块丢弃
      out += before;
      rest = "";
      break;
    }
    const rawJson = rest.slice(si + CARD_MARKER_START.length, ei).trim();
    rest = rest.slice(ei + CARD_MARKER_END.length);
    const normalized = normalizeModelCardJson(rawJson);
    out += before;
    if (normalized) {
      out += `${CARD_MARKER_START}\n${normalized}\n${CARD_MARKER_END}`;
    }
  }
  out += rest;
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 单个模型卡片 JSON 的校验与归一化；不可用返回 null（调用方整块丢弃） */
function normalizeModelCardJson(rawJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;
  if (!Array.isArray(obj.items) || obj.items.length === 0) return null;

  const items = obj.items
    .map((it: unknown): Record<string, unknown> | null => {
      if (typeof it === "string") {
        return it.trim() ? { type: "num", text: it.trim() } : null;
      }
      if (!it || typeof it !== "object") return null;
      const rec = it as Record<string, unknown>;
      const text = typeof rec.text === "string" ? rec.text.trim() : "";
      if (!text) return null;
      const item: Record<string, unknown> = {
        type: typeof rec.type === "string" && rec.type.trim() ? rec.type.trim() : "num",
        text,
      };
      for (const key of MODEL_CARD_ITEM_FIELDS) {
        const v = rec[key];
        if (typeof v === "string" && v.trim()) item[key] = v.trim();
      }
      return item;
    })
    .filter((v): v is Record<string, unknown> => !!v)
    .slice(0, 12);
  if (items.length === 0) return null;

  const cardType = typeof obj.cardType === "string" ? obj.cardType.trim() : "";
  const footer = typeof obj.footer === "string" ? obj.footer.trim() : "";
  return JSON.stringify({
    avatar: "NB",
    avatarStyle: "default",
    title,
    items,
    footer,
    cardType,
    actions: [],
    speak: "high",
    cardId: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
}

/** 从单行文本中提取 URL */
function extractUrlFromText(text: string): string | undefined {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[)}\]。，,]+$/, "") : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 根因修复：检测 LLM 把 tool result 原始 JSON 直接吐到回复里的情况
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 找出文本中所有「最外层 JSON 对象包络」（贪婪配对，处理嵌套 + 跨行）。
 *
 * 供 detectRawSearchResultJson / detectRawTravelItineraryJson 共用：
 * 对每个 `{` 起扫描到配对 `}`（跳过字符串字面量内的括号），返回按出现
 * 顺序排列的候选子串。嵌套对象也会作为候选出现（外层包络在前），
 * 由各检测器的签名判定决定哪个命中。
 */
function extractJsonEnvelopes(text: string): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    // 从 i 起扫描，找到匹配的右括号
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

/**
 * 判断字符串是否「看起来像域名」（用于恢复被 compactor 切掉 https:// 前缀的 URL）。
 *
 * 典型场景：compactor 在硬切 search_web 返回的 JSON 时，可能把 `"url":"https://..."`
 * 切到只剩 `"url":"movie.douban.com/..."`，LLM 又把这段破损 JSON 复制到 reply.text。
 * 我们要把它补成 `https://movie.douban.com/...`，让搜索结果卡能正常渲染。
 *
 * 判定规则（保守、宁缺毋滥）：
 *   - 含至少一个点（如 example.com / sub.example.co.uk）
 *   - 第一段（顶级域名前的主域）是合法域名片段（字母数字 + 连字符，不以连字符开头/结尾）
 *   - 顶级域名是常见 TLD（com/net/org/cn/gov/edu/io/app/dev/ai/...）
 *   - 不含空白 / 引号 / 反斜杠 / 大括号（这些一定不是 URL）
 *   - 长度 ≤ 500（防极端长字符串误判）
 */
function looksLikeDomain(s: string): boolean {
  if (!s || s.length > 500) return false;
  if (/[\s"'\\{}\[\]]/.test(s)) return false;
  // 必须以 http(s):// 开头以外的形式，但若以单斜杠或残缺 ttp:// 开头也算
  if (/^https?:\/\//i.test(s)) return true; // 防御性：理论上外层已排除
  // 形如 example.com / sub.example.com / example.com:8080/path
  const m = s.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(:\d+)?(\/[^\s]*)?$/i);
  if (!m) return false;
  const host = m[1].toLowerCase();
  const tld = host.split(".").pop() ?? "";
  // 常见 TLD 白名单（含中国常见 .cn / .com.cn 双段）
  const KNOWN_TLDS = new Set([
    "com", "net", "org", "cn", "com.cn", "gov", "gov.cn", "edu", "edu.cn",
    "io", "app", "dev", "ai", "co", "me", "tv", "info", "biz", "xyz",
    "top", "vip", "cc", "shop", "store", "tech", "cloud", "site", "online",
    "wiki", "news", "live", "social", "video", "music", "art", "design",
    "fm", "am", "fm", "cool", "fun", "pro", "group", "team", "world",
  ]);
  return KNOWN_TLDS.has(tld);
}

/**
 * 检测 LLM 输出中是否包含「搜索结果原始 JSON」（即直接复述 search_web/info.* 的
 * tool result）。典型形态：
 *   {"items":[{"title":"...","url":"...","snippet":"...","source":"..."}],"provider":"..."}
 *
 * 出现场景：LLM 在整合工具结果时，本应按 prompt 输出自然段或列表，
 * 但模型把整段 JSON 复制粘贴到回复里，绕过 render_hint 分类器的 list 识别，
 * 透出到前端让用户看到「`{"items":[{...},...]}... [truncated 870 chars]`」式脏展示。
 *
 * 命中条件（严格，避免误伤普通 JSON 描述）：
 *   1. 文本中能找到完整的 JSON 对象（包络 `{...}`，跨行也支持）
 *   2. 解析后顶层有 `items` 数组，数组长度 ≥ 2
 *   3. items 内元素是对象，含 `title`(string) + `url`(http(s) 开头) 字段
 *   4. 至少 50% 的 items 命中 (3) — 避免把 "items 中夹 1 个搜索项" 的偶发 JSON 误判
 *
 * 命中时返回 `{ items, cleanText }`：
 *   - items：解析出的搜索结果数组
 *   - cleanText：去掉 JSON 块（含前后引导句）后的纯文字，便于拼到卡片前/后
 *
 * 不命中返回 null。
 */
function detectRawSearchResultJson(
  text: string,
): { items: InfoSearchItem[]; cleanText: string } | null {
  const trimmed = text?.trim();
  if (!trimmed || trimmed.length < 30) return null;

  // 0. 防御：若文本已被 [AGENT_RESULT_CARD_START] 等标记包好，视为已结构化，不重复检测
  if (
    trimmed.includes("[AGENT_RESULT_CARD_START]") ||
    trimmed.includes("[CONTENT_SUMMARY_V2_START]") ||
    trimmed.includes("[RENDER_AS:") ||
    trimmed.includes("[VIDEO_MEDIA_START]") ||
    trimmed.includes("[CHAT_MEDIA_START]") ||
    trimmed.includes("[IMAGE_RESULT_START]")
  ) {
    return null;
  }

  // 1. 找最外层 JSON 对象包络
  const candidates = extractJsonEnvelopes(trimmed);
  if (candidates.length === 0) return null;

  // 2. 试解析每个候选，挑出最像「搜索结果 JSON」的那个
  //    判定：含 items 数组 + 数组里至少 2 个对象、对象含 title+url
  for (const raw of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const itemsRaw = obj.items;
    if (!Array.isArray(itemsRaw) || itemsRaw.length < 2) continue;
    const searchItems: InfoSearchItem[] = [];
    let validCount = 0;
    for (const it of itemsRaw) {
      if (!it || typeof it !== "object") continue;
      const rec = it as Record<string, unknown>;
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      const rawUrl = typeof rec.url === "string" ? rec.url.trim() : "";
      if (!title || !rawUrl) continue;
      // 容错：compactor 在硬切 JSON 时可能把 "https://" 前缀吃掉（变成
      // "movie.douban.com/..."）。这里对「看起来像域名」的残缺 URL 自动补回
      // https:// 前缀，确保破损 JSON 也能被识别为搜索结果卡（不再让脏 JSON
      // 透出到前端）。
      const url = /^https?:\/\//i.test(rawUrl)
        ? rawUrl
        : looksLikeDomain(rawUrl)
          ? `https://${rawUrl}`
          : "";
      if (!url) continue;
      const snippet = typeof rec.snippet === "string" ? rec.snippet.trim() : "";
      const source = typeof rec.source === "string" ? rec.source.trim() : "";
      const publishedAt =
        typeof rec.publishedAt === "string" ? rec.publishedAt.trim() : undefined;
      searchItems.push({
        title: title.slice(0, 180),
        url,
        snippet: snippet.slice(0, 220),
        source: source || "搜索",
        publishedAt,
      });
      validCount++;
    }
    if (validCount < 2) continue;
    if (validCount / itemsRaw.length < 0.5) continue;
    // 3. 把 JSON 块从原文本中剥掉（含可能的前后引导句），得到 cleanText
    //    策略：先在 trimmed 里找到 raw 的位置，剥掉 raw 本身；
    //    再把剥离 JSON 后空出来的相邻短句（"以下是搜索结果：" 等）也合并去掉。
    const jsonStart = trimmed.indexOf(raw);
    if (jsonStart < 0) continue;
    const before = trimmed.slice(0, jsonStart).trim();
    const after = trimmed.slice(jsonStart + raw.length).trim();
    // 「搜索结果公告句」：LLM 在 JSON 前写的「以下是搜索结果：」「下面是相关搜索：」等
    // 引导句。卡片本身已带 "搜索结果" 标题，重复公告无价值，识别后丢弃避免冗余。
    // 匹配规则：长度 ≤ 60 且命中公告关键词，标点结尾视为完整公告。
    const announceRe = /(搜索结果|搜到的|搜索到的|相关搜索|检索结果|以下是|下面是|查到了|查询到)/;
    const beforeIsAnnounce = before.length > 0 && before.length <= 60 && announceRe.test(before);
    const afterIsAnnounce = after.length > 0 && after.length <= 60 && announceRe.test(after);
    // after 若超出公告范围（带新结论/追问）则保留，否则视为"希望对您有帮助"等收尾短句丢弃
    const afterLooksLikeTrailer = after.length > 0 && after.length > 60;
    const cleanText = [
      beforeIsAnnounce ? "" : before,
      afterLooksLikeTrailer ? after : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return { items: searchItems, cleanText };
  }
  return null;
}

/**
 * 把搜索结果 items 数组拼成自然段 + AGENT_RESULT_CARD 卡片，让前端走搜索结果组件渲染。
 * 这是 detectRawSearchResultJson 的"修复器"——把脏 JSON 转换为结构化卡片。
 *
 * item.text 格式遵循 _SearchResultCard 的约定：用 `:` 把标题与摘要拆开，
 * 让前端组件把第一段当标题（加粗）、后续当描述；URL 走 item.url（可点击跳转）。
 */
function buildSearchResultCardFromItems(
  items: InfoSearchItem[],
  leadText: string,
  toolName: string | undefined,
): string {
  const title = "搜索结果";
  const cardItems = items.map((it) => {
    const head = it.title || it.url;
    const descParts: string[] = [];
    if (it.snippet) descParts.push(it.snippet);
    if (it.source) descParts.push(`来源:${it.source}`);
    const text = descParts.length > 0 ? `${head}: ${descParts.join("  \n")}` : head;
    return {
      type: "num",
      text,
      url: it.url,
      source: it.source || undefined,
    };
  });
  const payload = {
    avatar: "NB",
    avatarStyle: "default",
    title,
    items: cardItems,
    footer: `共 ${items.length} 条结果`,
    cardType: "search_result",
    cardId: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
  const card = `[AGENT_RESULT_CARD_START]\n${JSON.stringify(payload)}\n[AGENT_RESULT_CARD_END]`;
  if (!leadText) return card;
  return `${leadText}\n\n${card}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 根因修复②：检测 LLM 把 travel.plan-itinerary 行程 JSON 直接吐到回复里的情况
// ─────────────────────────────────────────────────────────────────────────────

/** 安全读字符串字段。 */
function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 检测 LLM 输出中是否包含「旅游行程原始 JSON」（即直接复述 travel.plan-itinerary
 * 的 summarizeItinerary 结果）。典型形态：
 *   {"ok":true,"title":"马尔代夫2日游…","destination":"马尔代夫",
 *    "days":[{"date":"2026-08-30","items":[{"type":"hotel","name":"…","startTime":"…"}]}]}
 *
 * 出现场景（真实案例）：
 *   1. 工具循环的「道歉式兜底」把 lastToolOutputFallback（工具输出原文）整段
 *      糊成回复（openai-compatible-tool-loop 的 effectiveFinalText 路径）；
 *   2. LLM 末轮直接把 tool result JSON 复制进正文。
 * 两种情况都会让原始 JSON 透出到前端（脏展示），而本应由 travel_itinerary
 * 双面板卡渲染。与 detectRawSearchResultJson 同构：命中后由
 * buildTravelItineraryCardFromPlan 确定性转卡。
 *
 * 命中条件（严格，避免误伤普通 JSON）：
 *   1. 文本中能找到完整 JSON 对象（包络 `{...}`，跨行也支持）；
 *   2. 顶层 `days` 是非空数组（≤30 天）；
 *   3. days[].items 里至少一半元素像行程条目：有非空 `name` 且带 `type`/`startTime`；
 *   4. 顶层 `title` 或 `destination` 至少一个非空（行程 JSON 顶层签名）。
 *
 * 命中时返回 `{ plan, cleanText }`：plan 为解析出的行程对象；
 * cleanText 为剥掉 JSON 块后的正文（LLM 在 JSON 前后写的引导/收尾句）。
 */
function detectRawTravelItineraryJson(
  text: string,
): { plan: Record<string, unknown>; cleanText: string } | null {
  const trimmed = text?.trim();
  if (!trimmed || trimmed.length < 30) return null;

  for (const raw of extractJsonEnvelopes(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const days = obj.days;
    if (!Array.isArray(days) || days.length < 1 || days.length > 30) continue;

    let totalItems = 0;
    let validItems = 0;
    for (const day of days) {
      if (!day || typeof day !== "object") continue;
      const items = (day as Record<string, unknown>).items;
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        totalItems++;
        const rec = it as Record<string, unknown>;
        const name = strField(rec.name);
        if (name && (strField(rec.type) || strField(rec.startTime))) validItems++;
      }
    }
    if (totalItems === 0 || validItems === 0) continue;
    if (validItems / totalItems < 0.5) continue;
    if (!strField(obj.title) && !strField(obj.destination)) continue;

    // 剥掉 JSON 块，保留前后正文
    const jsonStart = trimmed.indexOf(raw);
    if (jsonStart < 0) continue;
    const before = trimmed.slice(0, jsonStart).trim();
    const after = trimmed.slice(jsonStart + raw.length).trim();
    const cleanText = [before, after].filter(Boolean).join("\n\n");
    return { plan: obj, cleanText };
  }
  return null;
}

/** 行程逐天摘要行：`Day 1 · 2026-08-30：入住民宿 → 环礁浮潜 → 老城晚餐`。 */
function buildTravelDaySummaryItems(plan: Record<string, unknown>): string[] {
  const days = Array.isArray(plan.days) ? (plan.days as Array<Record<string, unknown>>) : [];
  const out: string[] = [];
  days.forEach((day, i) => {
    const date = strField(day?.date);
    const names = Array.isArray(day?.items)
      ? (day.items as Array<Record<string, unknown>>)
          .map((it) => strField(it?.name))
          .filter(Boolean)
      : [];
    let line = `Day ${i + 1}${date ? ` · ${date}` : ""}`;
    if (names.length > 0) {
      let body = names.slice(0, 4).join(" → ");
      if (names.length > 4) body += " 等";
      line += `：${body}`;
    }
    if (line.length > 80) line = `${line.slice(0, 79)}…`;
    out.push(line);
  });
  return out;
}

/**
 * 行程卡前的确定性短介绍（2026-10-11 用户要求「前面一段简短介绍 + 后面跟旅游卡片」）。
 *
 * 背景：真实轮次里模型可能一个字都没留下——上游 harness 控制帧把叙述挤掉了
 * （事故：finalText 61 字全是 `<system>[trajectory-slicing]…`，剥完为空），
 * 回复只剩一张卡，用户看到「只有卡片、没有介绍」。这里按行程数据兜一段简短
 * 介绍，**只在正文为空时补**，绝不覆盖模型自己写的口语回复。
 */
function buildTravelIntro(plan: Record<string, unknown>): string {
  const destination = strField(plan.destination);
  const days = Array.isArray(plan.days) ? (plan.days as Array<Record<string, unknown>>) : [];
  const dayCount = days.length;
  const stopCount = days.reduce(
    (n, d) => n + (Array.isArray(d?.items) ? (d.items as unknown[]).length : 0),
    0,
  );
  const head = destination
    ? `${destination}${dayCount > 0 ? `${dayCount}天` : ""}的行程`
    : "行程";
  const scale = dayCount > 0 && stopCount > 0 ? `（共 ${dayCount} 天 · ${stopCount} 项安排）` : "";
  return (
    `${head}我给你排好了${scale}：逐日的节奏、路线和每站停留都在下面这张卡里，` +
    "点「打开行程规划」能看完整明细；想调哪一天、或者加点什么，直接跟我说。"
  );
}

/** 行程卡 footer：天数/项数汇总 +（有价格汇总时）预计总花费。 */
function buildTravelItineraryFooter(plan: Record<string, unknown>): string {
  const days = Array.isArray(plan.days) ? (plan.days as Array<Record<string, unknown>>) : [];
  const totalItems = days.reduce(
    (n, d) => n + (Array.isArray(d?.items) ? (d.items as unknown[]).length : 0),
    0,
  );
  const parts = [`共 ${days.length} 天 · ${totalItems} 项安排`];
  const pricing = plan.pricingSummary;
  const totalFinal =
    pricing && typeof pricing === "object" && !Array.isArray(pricing)
      ? Number((pricing as Record<string, unknown>).totalFinal)
      : Number(plan.totalCost);
  if (Number.isFinite(totalFinal) && totalFinal > 0) {
    parts.push(`预计约 ¥${Math.round(totalFinal).toLocaleString("en-US")}`);
  }
  return parts.join(" · ");
}

/**
 * 由 LLM 回显的行程 JSON 构建结构化快照（travelItineraryStore 未命中时的兜底）。
 *
 * 回显 JSON 是 summarizeItinerary 的瘦身版（无图片/评论/坐标），双面板仍可
 * 完整渲染天/条目骨架，只是没有实拍图 —— 优于不注入 travelPlan（前端退回
 * 文本正则解析，信息更少）。
 */
function snapshotFromRawPlan(
  plan: Record<string, unknown>,
  title: string,
  destination: string,
): {
  toolName: string;
  ts: number;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  days: Array<{
    date: string;
    items: Array<{
      type: string;
      name: string;
      startTime: string;
      latitude: number;
      longitude: number;
      address: string;
      priceInfo: string;
      description: string;
      tips?: string[];
      images?: string[];
      reviews?: unknown[];
      videos?: Array<Record<string, unknown>>;
    }>;
  }>;
} {
  const days = Array.isArray(plan.days) ? (plan.days as Array<Record<string, unknown>>) : [];
  return {
    toolName: "travel.plan-itinerary",
    ts: Date.now(),
    destination,
    title,
    startDate: strField(plan.startDate),
    endDate: strField(plan.endDate),
    days: days.map((day) => ({
      date: strField(day?.date),
      items: (Array.isArray(day?.items) ? (day.items as Array<Record<string, unknown>>) : []).map(
        (it) => ({
          type: strField(it?.type) || "other",
          name: strField(it?.name),
          startTime: strField(it?.startTime) || strField(it?.name),
          latitude: Number(it?.latitude) || 0,
          longitude: Number(it?.longitude) || 0,
          address: strField(it?.address),
          priceInfo: strField(it?.priceInfo),
          description: strField(it?.description),
          tips: Array.isArray(it?.tips) ? (it.tips as unknown[]).map(String) : undefined,
          // 原始工具结果（attachTravelItineraryCard 路径）携带媒体字段，直接透传；
          // LLM 回显的瘦身 JSON 无这些字段，缺省 undefined 不影响前端渲染
          images: Array.isArray(it?.images) ? (it.images as unknown[]).map(String) : undefined,
          reviews: Array.isArray(it?.reviews) ? (it.reviews as unknown[]) : undefined,
          videos: Array.isArray(it?.videos)
            ? (it.videos as unknown[]).filter(
                (v): v is Record<string, unknown> => !!v && typeof v === "object",
              )
            : undefined,
        }),
      ),
    })),
  };
}

/**
 * 逐日逐站成文介绍（2026-10-25 需求：文字介绍随行程卡一起出来，放在卡之前）。
 * 形态：每天一块「Day N · 日期」，每站一行「HH:mm 站名 — 一句话介绍」；
 * 介绍优先级 why（为什么推荐）→ description；单条截 80 字，全空则该站只列名。
 * items 与 entries 两种键都读（冷层快照 / summarizeItinerary 瘦身版兼容）。
 */
export function buildTravelStoryText(plan: Record<string, unknown>): string {
  const days = Array.isArray(plan.days) ? (plan.days as Array<Record<string, unknown>>) : [];
  const blocks: string[] = [];
  days.forEach((day, i) => {
    const raw = Array.isArray(day?.items)
      ? (day.items as Array<Record<string, unknown>>)
      : Array.isArray(day?.entries)
        ? (day.entries as Array<Record<string, unknown>>)
        : [];
    const stops = raw.filter((it) => strField(it?.name));
    if (stops.length === 0) return;
    const date = strField(day?.date) || strField(day?.label);
    const lines: string[] = [`Day ${i + 1}${date ? ` · ${date}` : ""}`];
    stops.forEach((it) => {
      const name = strField(it?.name);
      let time = strField(it?.startTime) || strField(it?.time);
      const isoTimeStart = time.indexOf("T");
      if (isoTimeStart >= 0) time = time.slice(isoTimeStart + 1);
      const dash = time.search(/[-~—]/);
      if (dash > 0) time = time.slice(0, dash).trim();
      if (time.length > 5) time = time.slice(0, 5);
      const intro = [strField(it?.why), strField(it?.description)].find((s) => s.length > 0) ?? "";
      const introCut = intro.length > 80 ? `${intro.slice(0, 79)}…` : intro;
      const timeTag = time ? `${time} ` : "";
      lines.push(introCut ? `${timeTag}${name} — ${introCut}` : `${timeTag}${name}`);
    });
    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n");
}

/**
 * 把行程 JSON 转换成 travel_itinerary 双面板卡（detectRawTravelItineraryJson 的修复器）。
 *
 * 卡片结构化数据（travelPlan）来源优先级：
 *   1. travelItineraryStore 快照（skill 执行时写入，含图片/评论/坐标全量字段）；
 *   2. 回显 JSON 本身（summarizeItinerary 瘦身版，仅缺媒体字段）。
 * 逐天摘要行（Day N · 日期：亮点 → 亮点）供前端行程卡预览胶囊展示；
 * leadText（LLM 在 JSON 前写的引导句）保留在卡片之前；leadText 为空（模型没留下
 * 可见正文，例如整段被上游 harness 控制帧占掉）时由 [buildTravelIntro] 兜一段
 * 确定性短介绍——回复形态恒为「前面一段简短介绍 + 后面跟行程卡片」。
 */
function buildTravelItineraryCardFromPlan(
  plan: Record<string, unknown>,
  leadText: string,
): string {
  const destination = strField(plan.destination);
  const title = strField(plan.title) || (destination ? `${destination}行程规划` : "行程规划");
  const items = buildTravelDaySummaryItems(plan).map((text) => ({ type: "num", text }));
  const footer = buildTravelItineraryFooter(plan);

  // A4 数据源优先级：① planId 直读冷层（权威、含编辑后数据与 version）
  // → ② 文本匹配内存快照（2 分钟时效）→ ③ 原始 plan 就地转换。
  const coldPlan = strField(plan.planId) ? travelPlanStore.get(strField(plan.planId)) : null;
  const snap = coldPlan
    ? null
    : travelItineraryStore.findForText(`${title} ${destination} ${leadText}`);
  const travelPlan = coldPlan
    ? coldPlan
    : snap && snap.days.length > 0
      ? snap
      : snapshotFromRawPlan(plan, title, destination);

  const payload = {
    avatar: "NB",
    avatarStyle: "default",
    title,
    items,
    footer,
    cardType: "travel_itinerary",
    // 2026-09-17 用户需求：行程以「回复末尾的独立规划卡」呈现——卡面直接
    // 逐日展示安排，不再自动弹出双面板（autoOpen=false）；完整明细由用户
    // 点卡片上的「打开行程规划」按钮按需进入。
    autoOpen: false,
    cardId: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    travelPlan,
  };
  const card = `[AGENT_RESULT_CARD_START]\n${JSON.stringify(payload)}\n[AGENT_RESULT_CARD_END]`;
  // 卡前导：优先模型的口语回复；正文为空（被内部帧清空 / 模型没叙述）时补一段
  // 确定性短介绍 → 回复形态恒为「前面一段简短介绍 + 后面跟行程卡片」。
  const lead = leadText || buildTravelIntro(travelPlan as unknown as Record<string, unknown>);
  // 2026-10-25 需求：文字介绍放在行程卡之前——模型口语引导 + 逐日逐站介绍 + 卡片
  const story = buildTravelStoryText(travelPlan as unknown as Record<string, unknown>);
  return [lead, story, card].filter((s) => s.trim().length > 0).join("\n\n");
}

/**
 * 从文本中剥离 `[AGENT_RESULT_CARD_START] ... [AGENT_RESULT_CARD_END]` 卡片块。
 *
 * 场景：结构化 mediaCards 已由 chat.assistant_done 独立字段下发时，LLM 正文里
 * 若仍残留 cardType=media 的卡片块（attachMediaSearchMarker 注入的同一批照片），
 * 前端会把它当纯文本渲染，造成"文字反复/来回渲染"+ 与 mediaCards 双份展示。
 * 这类**重复的媒体卡**要确定性剥除。
 *
 * 其余卡片一律保留（2026-08-30 用户反馈：文本场景里的媒体/结果卡有自己的
 * 展示价值，不能一刀切拦截）：
 *   - travel_itinerary 行程卡：携带 autoOpen 与结构化行程数据，剥掉会丢右侧
 *     双面板的自动展开和面板数据；
 *   - search_result / 通用列表卡：正文场景的搜索结果、结论列表，与 mediaCards
 *     内容不同源，剥掉等于把有价值的信息一起扔掉；
 *   - 解析失败的卡片块：按可剥处理（防止 LLM 抄坏的 JSON 透出到前端）。
 */
export function stripMediaCardMarker(text: string): string {
  const START = "[AGENT_RESULT_CARD_START]";
  const END = "[AGENT_RESULT_CARD_END]";
  let out = "";
  let rest = text;
  // 循环剥除，直到没有完整的一对开始/结束标记（含 ASR/搜索等链式注入）
  for (let guard = 0; guard < 20; guard++) {
    const si = rest.indexOf(START);
    const ei = si === -1 ? -1 : rest.indexOf(END, si);
    if (si === -1 || ei === -1) break;
    const rawJson = rest.slice(si + START.length, ei).trim();
    // 保留：行程卡（autoOpen+结构化数据）与可解析的非 media 卡（搜索结果/列表等
    // 文本场景卡）。剥除：与 mediaCards 重复的 media 卡，以及解析失败的损坏块
    //（防止 LLM 抄坏的 JSON 透出到前端）。
    let keep = isTravelItineraryCardJson(rawJson);
    if (!keep) {
      try {
        const parsed: unknown = JSON.parse(rawJson);
        // 可解析对象且不是 media 卡 → 保留（文本场景卡）；media 卡/损坏块 → 剥除
        keep = !!parsed && typeof parsed === "object" && !isMediaCardJson(rawJson);
      } catch {
        keep = false;
      }
    }
    if (keep) {
      out += rest.slice(0, ei + END.length);
    } else {
      out += rest.slice(0, si);
    }
    rest = rest.slice(ei + END.length);
  }
  out += rest;
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 判断一段卡片块内的 JSON 是否为 cardType=media 的媒体卡（与 mediaCards
 * 独立字段重复下发的那类）。解析失败返回 false —— 失败的块由调用方单独
 * 剥除（防损坏 JSON 透到前端），不走本判定。
 */
function isMediaCardJson(rawJson: string): boolean {
  if (!rawJson.includes("cardType")) return false;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>)["cardType"] === "media"
    );
  } catch {
    return false;
  }
}

/**
 * 判断一段卡片块内的 JSON 是否为 travel_itinerary 行程卡。
 *
 * 解析失败（LLM 抄坏的 JSON / 非卡片块）一律视为非行程卡，由调用方按
 * 普通卡片块处理。
 */
export function isTravelItineraryCardJson(rawJson: string): boolean {
  if (!rawJson.includes("travel_itinerary")) return false;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>)["cardType"] === "travel_itinerary"
    );
  } catch {
    return false;
  }
}

/** 判断文本中是否已存在 travel_itinerary 行程卡块（扫描全部卡片块，不只第一对）。 */
export function containsTravelItineraryCard(text: string): boolean {
  if (!text.includes("[AGENT_RESULT_CARD_START]")) return false;
  const re =
    /\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g;
  for (const match of text.matchAll(re)) {
    if (isTravelItineraryCardJson(match[1]?.trim() ?? "")) return true;
  }
  return false;
}

/**
 * 旅游行程的确定性附卡（chat.assistant_done 前的最后防线，Coze 式架构）。
 *
 * 工具返回值已瘦身（summarizeItinerary 只留极简摘要），LLM 的口头回复不再携带
 * 行程明细，也就写不出能被切卡的逐日列表——卡片必须
 * 由代码直接从工具原始结果生成，不依赖 LLM 转发：
 *   - 若正文已有 travel_itinerary 行程卡（LLM 列表路径/检测器路径已出卡）→
 *     不重复附加；
 *   - 正文只有普通卡片块（如 processAssistantText 把口语回复切成了通用列表卡）
 *     时仍要附加：通用卡没有 autoOpen/结构化数据，客户端解析器会优先取行程卡，
 *     缺卡会导致右侧双面板既不自动展开也没有数据；
 *   - 否则以原始工具结果（全量字段：坐标/图片/评论/视频）构建 travel_itinerary
 *     卡（autoOpen=false，卡面直接逐日展示安排、不自动弹出双面板），拼在正文
 *     之后。正文（LLM 的自然口语回复）保留为卡前导。
 */
export function attachTravelItineraryCard(
  text: string,
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): string {
  if (toolName !== "travel.plan-itinerary" || !toolResult) return text;
  // A4 主路径：工具回执携带 planId（id 字段）→ 直读冷层权威数据建卡。
  // 不再依赖 2 分钟时效的内存快照与目的地名文本匹配（历史串卡根因）。
  const planId = strField(toolResult.id);
  if (planId) {
    const cold = travelPlanStore.get(planId);
    if (cold && cold.days.length > 0) {
      if (containsTravelItineraryCard(text)) return text;
      return buildTravelItineraryCardFromPlan(
        { ...cold, title: strField(toolResult.title) || cold.title },
        text.trim(),
      );
    }
  }
  const days = toolResult.days;
  if (!Array.isArray(days) || days.length === 0) return text;
  if (containsTravelItineraryCard(text)) return text;
  return buildTravelItineraryCardFromPlan(toolResult, text.trim());
}

/**
 * 行程 JSON 的纯文本摘要（plainTextMode 兜底，微信桥等不支持卡片渲染的端）：
 * 标题 + 逐天摘要行，不携带任何原始 JSON。
 */
function buildTravelPlainTextSummary(
  plan: Record<string, unknown>,
  leadText: string,
): string {
  const title = strField(plan.title) || `${strField(plan.destination)}行程规划`;
  const lines = buildTravelDaySummaryItems(plan);
  const footer = buildTravelItineraryFooter(plan);
  const lead = leadText || buildTravelIntro(plan);
  const story = buildTravelStoryText(plan);
  return [lead, story, title, ...lines, footer].filter(Boolean).join("\n\n");
}

export interface ToolResultProcessorOptions {
  enabled?: boolean;
  threshold?: number;
}

export class ToolResultProcessor {
  private options: Required<ToolResultProcessorOptions>;

  constructor(options: ToolResultProcessorOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      threshold: options.threshold ?? CONTENT_LENGTH_THRESHOLD,
    };
  }

  processAssistantText(
    text: string,
    opts?: {
      plainTextMode?: boolean;
      userText?: string;
      toolName?: string;
      /** 本轮工具结构化回执：注册工具（tool-card-registry）据此直出卡，不依赖 LLM 抄写列表 */
      toolResult?: Record<string, unknown>;
    },
  ): string {
    if (!this.options.enabled) {
      return text;
    }

    // 人化改稿闸已删除（2026-10-13 根修）：本管线处理的是**已流式送达用户**的
    // 最终文本，prose 层再改写（humanizeAssistantText 的客服腔清洗/口头禅清理）
    // 就是「先流式输出一段、done 落库另一段」的根源之一。模型文本即权威，
    // 这里只做结构化（卡片/标记/渲染路由）。人化约束归 prompt 层；
    // 认知快路径（agent-core）在流式**前**的人化保持不变（流=落库一致）。

    // === -1. 系统内部帧守卫：线程存档里的非用户可见文本既不做形态判定，也不下发 ===
    // 真实数据回放发现：[session-recap] 记忆回顾、[后台任务记录]、[上一轮回复中断]
    // 这类系统帧若流入本管线，会被列表/时间戳特征误判上卡（回放案例：recap 带
    // 日期列表被判成 progress 卡）。
    //
    // 2026-10-08 升级：此前这里 return humanize(text) —— 语义只是「跳过渲染路由」，
    // 文本原样交回，照样进 finalText → chat.assistant_done → 气泡（手机端事故气泡
    // 就是这么来的：模型把线程里的占位帧当「自己上一轮说过的话」复读，本守卫放行了）。
    // 现在按内部帧契约判定：整条是内部帧 → 直接不下发；混有内部帧 → 剥帧留正文。
    if (isInternalFrameText(text)) {
      console.log("[ToolResultProcessor] system_frame: hidden from user");
      return "";
    }
    // 2026-10-11 升级：XML 形态的 `<system>` control frame（上游 harness 轨迹切分帧）
    // 整条就是它时同样不下发。实测事故：旅行规划轮 finalText 61 字全是
    // `<system>[trajectory-slicing]…`，此前只有 `[…]` 形态判定，整条漏网直穿气泡。
    if (isSystemFrameText(text)) {
      console.log("[ToolResultProcessor] system_frame(system): hidden from user");
      return "";
    }
    if (hasInternalFrameTag(text)) {
      const cleaned = stripInternalFrames(text);
      if (!cleaned.trim()) {
        console.log("[ToolResultProcessor] system_frame: stripped to empty");
        return "";
      }
      text = cleaned;
    }

    // === 0. 检查 LLM 声明的 [RENDER_HINT:xxx]（优先级最高）===
    const { rawHint: llmHint, cleanText: textAfterLlmHint } = extractLlmRenderHint(text);
    // L2：模型自声明的卡片块先经校验/归一化（合法补默认值、非法整块丢弃），
    // 后续所有分支与"已带标记直接放行"看到的都是干净的标准块。
    let workingText = stripResidualRenderDeclarations(
      sanitizeModelCardBlocks(textAfterLlmHint),
    );
    if (llmHint) {
      console.log(`[ToolResultProcessor] LLM declared render_hint: ${llmHint}`);
      switch (llmHint) {
        case "structured":
          return wrapRenderAs("structured", workingText);
        case "brief":
          return wrapRenderAs("brief", workingText);
        case "card":
          return formatAgentResultForChat(workingText, opts?.toolName) ?? workingText;
        case "plain":
          return workingText;
      }
      // 未知 hint → fall through 走规则判断
    }

    const trimmed = workingText.trim();
    // 空文本返回"消毒后"的 workingText（模型坏卡块已被丢弃），不能返回原文——
    // 否则被 sanitize 丢弃的损坏 JSON 会从早退分支漏回前端。
    if (!trimmed) return workingText;

    // 已带标记的直接放行（避免二次处理）
    if (
      trimmed.includes("[CONTENT_SUMMARY_V2_START]") ||
      trimmed.includes("[AGENT_RESULT_CARD_START]")
    ) {
      return workingText;
    }

// === 优先级 -2：注册工具的结构化结果直出卡（B 阶段，tool-card-registry） ===
    // 工具回执有 schema，卡由代码确定性构建，LLM 口头回复只作前导正文——
    // 不依赖 LLM 把结果抄写成 markdown 列表（那正是大多数工具轮次漏卡的根因）。
    // 未注册工具 / builder 建卡失败 / plainTextMode → 返回 null，回退下方文本路由。
    if (!opts?.plainTextMode && opts?.toolName && opts?.toolResult) {
      const marked = tryAttachToolResultCard(workingText, opts.toolName, opts.toolResult);
      if (marked) {
        console.log(
          `[ToolResultProcessor] tool_card registry: ${opts.toolName} → structured card`,
        );
        return marked;
      }
    }

// === 优先级 -1：LLM 把 tool result 原始 JSON 直接吐到回复里 → 转结构化卡片 ===
    // 在所有 hint 路由之前优先检测，确保脏 JSON 不泄漏到前端。
    const detected = detectRawSearchResultJson(trimmed);
    if (detected) {
      console.log(
        `[ToolResultProcessor] raw_search_result_json: items=${detected.items.length} ` +
          `tool=${opts?.toolName ?? "unknown"}`,
      );
      const cardText = buildSearchResultCardFromItems(
        detected.items,
        detected.cleanText,
        opts?.toolName,
      );
      if (opts?.plainTextMode) {
        return detected.cleanText;
      }
      return cardText;
    }

    // === 优先级 -1.5：LLM 把 travel 行程 JSON 直接吐到回复里 → 转 travel_itinerary 双面板卡 ===
    // 与上方搜索 JSON 检测同构（两者签名互斥：items+title+url vs days+name+startTime），
    // 在 routeRender 之前拦截，确保行程 JSON 不以脏文本透出、直接上双面板卡。
    const travelDetected = detectRawTravelItineraryJson(trimmed);
    if (travelDetected) {
      const dayCount = Array.isArray(travelDetected.plan.days)
        ? (travelDetected.plan.days as unknown[]).length
        : 0;
      console.log(
        `[ToolResultProcessor] raw_travel_itinerary_json: days=${dayCount} ` +
          `tool=${opts?.toolName ?? "unknown"}`,
      );
      if (opts?.plainTextMode) {
        return buildTravelPlainTextSummary(travelDetected.plan, travelDetected.cleanText);
      }
      return buildTravelItineraryCardFromPlan(travelDetected.plan, travelDetected.cleanText);
    }

    // === 渲染形态判断中心（经 gateway 统一路由，含 trace） ===
    const hint = routeRender(workingText, {
      toolName: opts?.toolName,
      userText: opts?.userText,
    });

    // 优先级 0：image_text 图片识别/OCR → 注入 [RENDER_AS:image_result]
    if (hint.type === "image_text") {
      console.log(`[ToolResultProcessor] image_text: ${hint.reason}`);
      return wrapRenderAs("image_result", workingText);
    }

    // 优先级 1：search_result 搜索工具结果 → 专用搜索结果卡片（含 URL 提取）
    if (hint.type === "search_result" && !opts?.plainTextMode) {
      let marked = formatAgentResultForChat(workingText, opts?.toolName);
      if (marked) {
        // 从 item 文本中提取 URL 注入到 JSON
        marked = injectItemUrls(marked);
        console.log(`[ToolResultProcessor] search_result: ${hint.reason}`);
        return marked;
      }
    }

    // 优先级 1.5：data_brief 数据快报 → 注入 [RENDER_AS:data_brief] + [DATA_BRIEF_START] payload。
    // 用原始文本提取（正文零改写，数值不被口语化），前端解析失败时回退纯文本。
    if (hint.type === "data_brief") {
      console.log(`[ToolResultProcessor] data_brief: ${hint.reason}`);
      if (opts?.plainTextMode) return workingText;
      const payload = extractDataBriefPayload(workingText);
      return wrapRenderAs(
        "data_brief",
        `[DATA_BRIEF_START]${JSON.stringify(payload)}[DATA_BRIEF_END]`,
      );
    }

    // 优先级 2：result_card 简短汇报
    if (hint.type === "result_card" && !opts?.plainTextMode) {
      let marked = formatAgentResultForChat(workingText, opts?.toolName);
      if (marked) {
        // 同样注入 item 级 url（媒体卡片依赖它渲染缩略图/跳转）
        marked = injectItemUrls(marked);
        console.log(`[ToolResultProcessor] result_card: ${hint.reason}`);
        return marked;
      }
    }

    // 优先级 2.5：markdown 引用块（> xxx）→ quote 引用强调卡。
    // 纯程序路由（display-effect-router.hasBlockquote），无 LLM 参与；
    // 引用块天然是一句话结论/强调场景，优先于 brief/structured。
    if (!opts?.plainTextMode && hasBlockquote(workingText)) {
      const marked = formatAgentResultForChat(workingText, opts?.toolName);
      if (marked) {
        console.log("[ToolResultProcessor] quote: markdown blockquote detected");
        return marked;
      }
    }

    // 优先级 3+：brief 简报形态（L2 模型声明 only；打分退役后不再从散文猜简报）
    if (hint.type === "brief") {
      console.log(`[ToolResultProcessor] brief: ${hint.reason}`);
      return wrapRenderAs("brief", workingText);
    }

    // 优先级 3：summary_card 长内容折叠
    // 媒体搜索轮禁入（不变量，与模型无关）：照片/视频卡是本轮唯一主形态，
    // 摘要折叠卡若附进正文，媒体轮清洗（stripMediaEchoText 不认识该标记）
    // 剥不掉，会以裸 JSON 透出到前端（2026-10-10 搜图轮 CONTENT_SUMMARY 泄漏）。
    // 换模型只会改变「文本多长才触发折叠」的概率，不该改变路由契约。
    if (hint.type === "summary_card" && !isMediaSearchTool(opts?.toolName)) {
      console.log(
        `[ToolResultProcessor] Processing text, length: ${workingText.length}, threshold: ${this.options.threshold}, plainTextMode: ${!!opts?.plainTextMode}`,
      );

      if (shouldSummarizeContent(workingText, this.options.threshold)) {
        const summary = createContentSummary(workingText, {
          maxLength: this.options.threshold,
          forceSummary: false,
        });

        if (summary) {
          console.log(
            `[ToolResultProcessor] Created summary: ${summary.title}, points: ${summary.briefPoints.length}`,
          );
          const formatted = opts?.plainTextMode
            ? formatContentSummaryForPlainText(summary)
            : formatContentSummaryForChat(summary);
          console.log(
            `[ToolResultProcessor] Formatted output length: ${formatted.length}`,
          );
          return formatted;
        }
      }
    }

    // 优先级 4：long_text 长内容（非搜索工具）→ 意图触发走结构化富文本，否则纯文本
    if (hint.type === "long_text") {
      console.log(`[ToolResultProcessor] long_text: ${hint.reason}`);
      if (hint.intent) {
        return wrapRenderAs("structured", workingText);
      }
      return workingText;
    }

    // 优先级 5：plain 普通正文（无硬信号 → 纯文本，不硬塞形态）
    return workingText;
  }
}

/**
 * 从 `[AGENT_RESULT_CARD_START]` 标记的 JSON 中，
 * 给每个 item 提取文本中的 URL 并注入 `url` 字段。
 */
function injectItemUrls(marked: string): string {
  const startTag = "[AGENT_RESULT_CARD_START]";
  const endTag = "[AGENT_RESULT_CARD_END]";
  const startIdx = marked.indexOf(startTag);
  const endIdx = marked.indexOf(endTag);
  if (startIdx < 0 || endIdx <= startIdx) return marked;

  const jsonStr = marked.slice(startIdx + startTag.length, endIdx).trim();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    return marked;
  }

  const items = payload.items as Array<Record<string, string>> | undefined;
  if (!items) return marked;

  for (const item of items) {
    if (!item.url && item.text) {
      const url = extractUrlFromText(item.text);
      if (url) item.url = url;
    }
  }
  payload.items = items;

  // 保留标记外的前导对话与结尾追问：formatAgentResultForChat 的三段输出
  // 设计（[前导][卡片][追问]）在重建时不能被截掉，否则「好的，耳机已下单…」
  // 「需要调整吗？」这类上下文在主链路上全部丢失。
  const prefix = marked.slice(0, startIdx);
  const suffix = marked.slice(endIdx + endTag.length);
  return `${prefix}${startTag}${JSON.stringify(payload, null, 2)}${endTag}${suffix}`;
}

let _instance: ToolResultProcessor | null = null;

export function getToolResultProcessor(): ToolResultProcessor {
  if (!_instance) {
    _instance = new ToolResultProcessor();
  }
  return _instance;
}

/**
 * 视频媒体标记注入：
 * 当本轮回复的视频工具（`video.grab` 贴链接解析 / `video.find` 按内容找视频）
 * 结果带可播放视频流时，在回复文本上附加 `[RENDER_AS:video]` + `[VIDEO_MEDIA_START]`
 * 媒体标记。前端解析该标记后，用后端视频代理路由真实内联播放视频（媒体 URL 经代理避免跨域/防盗链）。
 *
 * 设计：
 *   - 不依赖 LLM 是否在正文里回显视频地址——直接取工具结果里的 videoUrl，确定性注入
 *   - 无视频流（反爬/需登录）时原样返回，前端按普通文本展示播放页链接
 */
export function attachVideoMediaMarker(
  text: string,
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): string {
  if (toolName !== "video.grab" && toolName !== "video.find") return text;
  const source = resolveVideoMediaSource(toolName, toolResult);
  if (!source) return text;

  const videoUrl = String(source.videoUrl ?? "").trim();
  const playPageUrl = String(source.playPageUrl ?? "").trim();
  const payload: Record<string, unknown> = {
    mediaType: "video",
    mediaUrl: buildProxyMediaUrl(videoUrl, playPageUrl),
  };
  const thumbnailUrl = String(source.thumbnailUrl ?? "").trim();
  if (thumbnailUrl) payload.thumbnailUrl = buildProxyMediaUrl(thumbnailUrl, playPageUrl);
  if (playPageUrl) payload.pageUrl = playPageUrl;
  const title = String(source.title ?? "").trim();
  if (title) payload.title = title;
  const author = String(source.author ?? "").trim();
  if (author) payload.author = author;
  const duration = Number(source.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) payload.durationSeconds = duration;
  if (Array.isArray(source.notes)) {
    const notes = source.notes.map(String).filter((n: string) => n.trim());
    if (notes.length) payload.notes = notes;
  }

  const block = `[VIDEO_MEDIA_START]\n${JSON.stringify(payload)}\n[VIDEO_MEDIA_END]`;
  // 2026-10-02 定稿：视频轮正文只出播放卡（卡面已含标题/作者/封面），模型口播的
  // 直链/封面图原始地址/保存步骤等冗余文本一律不保留——用户诉求「视频出来就行」。
  return `[RENDER_AS:video]\n${block}`;
}

/**
 * 从视频类工具回执中归一出单个可播放源：
 *   - video.grab：结果顶层即视频字段；
 *   - video.find：结果为 items 列表，取第一个带 videoUrl 的条目。
 * 返回 null 表示无可播放流（调用方按降级路径处理）。
 */
export function resolveVideoMediaSource(
  toolName: string,
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!result) return null;
  if (toolName === "video.grab") {
    return String(result.videoUrl ?? "").trim() ? result : null;
  }
  if (toolName === "video.find") {
    const items = Array.isArray(result.items) ? result.items : [];
    for (const it of items) {
      const o = (it ?? {}) as Record<string, unknown>;
      if (String(o.videoUrl ?? "").trim()) return o;
    }
    return null;
  }
  return null;
}

/** 把上游原始媒体地址包装为后端代理 URL（避免前端跨域与防盗链问题） */
function buildProxyMediaUrl(rawUrl: string, referer?: string): string {
  const base = `/agent/media/proxy?url=${encodeURIComponent(rawUrl)}`;
  if (referer) return `${base}&referer=${encodeURIComponent(referer)}`;
  return base;
}

/**
 * 搜索类媒体工具判定（不变量）：search_images / search_images_batch /
 * search_videos 的产出照片/视频由 mediaCards 结构化卡片承载，本轮主形态是
 * 媒体——摘要折叠卡（CONTENT_SUMMARY）等文本形态整卡禁入。
 * 集中成函数而不是散落各处：新增媒体工具时只改这一处。
 */
export function isMediaSearchTool(toolName: string | undefined | null): boolean {
  return (
    toolName === "search_images" ||
    toolName === "search_images_batch" ||
    toolName === "search_videos"
  );
}

/**
 * 媒体搜索（search_images / search_videos）确定性卡片注入。
 *
 * 为什么需要：媒体搜索工具结果里含 thumbnailUrl/mediaUrl（图片已转存为服务端
 * 本地 PNG），但 LLM 输出文本时不一定回显这些地址，导致前端 media 卡片拿不到
 * 缩略图、照片永远显示不出来。这里直接取工具结果 items，确定性生成
 * `[AGENT_RESULT_CARD_START]` media 卡片，不依赖 LLM 转发。
 */
export function attachMediaSearchMarker(
  text: string,
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): string {
  if (toolName !== "search_images" && toolName !== "search_videos") return text;
  if (!toolResult) return text;
  const rawItems = Array.isArray(toolResult.items) ? toolResult.items : [];
  if (rawItems.length === 0) return text;

  const isVideo = toolName === "search_videos";
  const cardItems: Array<Record<string, unknown>> = [];
  for (const raw of rawItems.slice(0, 6)) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const title = String(it.title ?? "").trim();
    const thumbnailUrl = String(it.thumbnailUrl ?? "").trim();
    const mediaUrl = String(it.mediaUrl ?? "").trim();
    const pageUrl = String(it.pageUrl ?? "").trim();
    const source = String(it.source ?? "").trim();
    const width = Number(it.width);
    const height = Number(it.height);
    // 丢弃没有任何可加载媒体地址的无效项（空缩略图/空媒体地址），
    // 保证渲染出来的媒体卡片每个都能看到图，不夹带"占了位置的空白项"。
    const hasMedia = !!(thumbnailUrl || mediaUrl);
    if (!hasMedia) continue;
    cardItems.push({
      type: isVideo ? "video" : "image",
      title: title || source || (isVideo ? "相关视频" : "图片结果"),
      // 视频只认真实缩略图，绝不把播放页/搜索页 URL 当图下发；
      // 图片则优先本地 PNG，其次媒体地址（前端会走代理解析）。
      thumbnailUrl: isVideo ? thumbnailUrl : thumbnailUrl || mediaUrl || "",
      mediaType: isVideo ? "video" : "image",
      pageUrl,
      source,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    });
  }
  if (cardItems.length === 0) return text;

  // 已带卡片/折叠标记则不重复注入
  if (
    text.includes("[AGENT_RESULT_CARD_START]") ||
    text.includes("[CONTENT_SUMMARY_V2_START]")
  ) {
    return text;
  }

  const payload: Record<string, unknown> = {
    cardType: "media",
    title: isVideo ? "相关视频" : "相关图片",
    items: cardItems,
    footer: `共 ${cardItems.length} 条${isVideo ? "视频" : "图片"}结果，点击可查看原图`,
  };
  const block = `[AGENT_RESULT_CARD_START]\n${JSON.stringify(payload, null, 2)}\n[AGENT_RESULT_CARD_END]`;
  return `${block}\n\n${text.trim()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 结构化媒体卡片（Coze 式架构：脱离 LLM 文本，独立下发）
// ─────────────────────────────────────────────────────────────────────────────

/** 单条媒体卡片条目（前端直接渲染为缩略图+来源）。 */
export type MediaCardItem = {
  type: "image" | "video";
  title: string;
  /** 缩略图 URL（优先本地 PNG，其次媒体地址） */
  thumbnailUrl: string;
  /** 媒体地址 */
  mediaUrl?: string;
  /**
   * 已解析出的可播放视频流（经 /agent/media/proxy 代理，仅视频卡有）。
   * 前端拿到此字段后点击卡片走右侧双栏面板内联播放，而不是跳外部链接；
   * 为空表示上游没解析出流（反爬/需登录），前端才降级为打开播放页。
   */
  playableUrl?: string;
  /** 来源页 URL */
  pageUrl?: string;
  /** 来源名称 */
  source?: string;
  /** 原图宽（像素，可选）：前端按原始宽高比渲染大图，避免竖幅人像被裁切 */
  width?: number;
  /** 原图高（像素，可选）：与 width 配合得出自然宽高比 */
  height?: number;
  /**
   * 对比分组维度标题（如「水屋」「沙屋」）。为空表示不分组，
   * 前端按普通图廊渲染；非空时按此字段分组、左右两侧分栏展示。
   */
  groupTitle?: string;
  /** 对比侧：A=左侧（sideA）/ B=右侧（sideB） */
  side?: "A" | "B";
  /** 侧标签（如「马尔代夫」「印尼」），用于左右分栏表头 */
  sideLabel?: string;
  /**
   * 真实图片描述（Coze 式「一图一句」，2026-09-03）：
   * 由视觉模型看图生成（image-caption-service），描述画面实际可见内容。
   * 前端渲染在对应照片下方；为空表示未生成（回退旧的正文交错排版）。
   */
  caption?: string;
};

/**
 * 从工具执行结果中提取结构化媒体卡片数据。
 *
 * 与 `attachMediaSearchMarker`（嵌入文本）不同，本函数返回纯数据结构，
 * 由 `chat.assistant_done` 作为独立 `mediaCards` 字段下发，前端直接渲染。
 * LLM 只负责"要不要搜图"，不负责"图片怎么展示"。
 *
 * 支持的工具：search_images, search_images_batch, search_videos, image.generate
 * 返回空数组 = 无媒体卡片（不阻塞前端渲染）。
 *
 * 对比分组：search_images_batch 返回的 items 带 compareSide/compareLabel/
 * compareGroup 元数据，这里透传为 groupTitle / side / sideLabel，
 * 前端据此按维度分组、左右两侧分栏渲染。
 */
export function extractMediaCards(
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): MediaCardItem[] {
  // 图像生成（image.generate）：生成图与搜索图走同一条结构化媒体卡链路。
  // 此前生成图 URL 只存在于工具结果文本里，LLM 转述时不落正文（或落了也被
  // echo 剥离）→ 用户只看到「画好了」却见不到图。这里确定性建卡：
  // done 聚合 / renderBlocks / chat.media_ready 早推全部复用这一条路径。
  if (toolName === "image.generate") {
    const imageUrl = String(toolResult?.imageUrl ?? "").trim();
    if (!imageUrl) return [];
    return [
      {
        type: "image",
        title: "生成的图片",
        thumbnailUrl: imageUrl,
        mediaUrl: imageUrl,
      },
    ];
  }
  // 照片风格化（picture.stylize）：风格版确定性建图卡（caption 带风格名）。
  if (toolName === "picture.stylize") {
    const photo = toolResult?.photo as Record<string, unknown> | undefined;
    const imageUrl = String(photo?.imageUrl ?? "").trim();
    if (!imageUrl) return [];
    const styleLabel = String(toolResult?.styleLabel ?? "").trim();
    return [
      {
        type: "image",
        title: styleLabel ? `风格化 · ${styleLabel}` : "风格化",
        thumbnailUrl: String(photo?.thumbnailUrl ?? "").trim() || imageUrl,
        mediaUrl: imageUrl,
        caption: styleLabel ? `已变成「${styleLabel}」风格` : undefined,
      },
    ];
  }
  // 照片记忆回顾（picture.memories）：记忆段代表照片建图卡，caption 走
  // 视觉分析的一句短句（没有则留空，前端按普通图廊渲染）。
  if (toolName === "picture.memories") {
    const memories = Array.isArray(toolResult?.memories) ? toolResult.memories : [];
    const cards: MediaCardItem[] = [];
    for (const memory of memories as Array<Record<string, unknown>>) {
      const photos = Array.isArray(memory?.photos) ? memory.photos : [];
      for (const photo of photos as Array<Record<string, unknown>>) {
        const thumbnailUrl = String(photo?.thumbnailUrl ?? "").trim();
        const imageUrl = String(photo?.imageUrl ?? "").trim();
        if (!thumbnailUrl && !imageUrl) continue;
        cards.push({
          type: "image",
          title: String(memory?.title ?? "记忆").trim() || "记忆",
          thumbnailUrl: thumbnailUrl || imageUrl,
          mediaUrl: imageUrl || thumbnailUrl,
          ...(typeof photo?.caption === "string" && photo.caption.trim()
            ? { caption: photo.caption.trim() }
            : {}),
        });
      }
      if (cards.length >= 9) break;
    }
    return cards.slice(0, 9);
  }
  if (
    toolName !== "search_images" &&
    toolName !== "search_images_batch" &&
    toolName !== "search_videos"
  ) {
    return [];
  }
  if (!toolResult) return [];

  const rawItems = Array.isArray(toolResult.items) ? toolResult.items : [];
  // 分组结构（search_images_batch）存在时优先按分组平铺（保留顺序与元数据）
  const rawGrouped = Array.isArray(toolResult.mediaGroups)
    ? (toolResult.mediaGroups as Array<Record<string, unknown>>)
    : [];
  const sources: Array<Record<string, unknown>> =
    rawGrouped.length > 0
      ? rawGrouped.flatMap((g) => {
          const groupTitle = String(g.title ?? "").trim();
          const sideA = String(g.sideA ?? "").trim();
          const sideB = String(g.sideB ?? "").trim();
          const merged: Array<Record<string, unknown>> = [];
          for (const item of asItems(g.itemsA)) {
            merged.push({
              ...item,
              ...(groupTitle ? { compareGroup: groupTitle } : {}),
              ...(sideA ? { compareLabel: sideA } : {}),
              compareSide: "A",
            });
          }
          for (const item of asItems(g.itemsB)) {
            merged.push({
              ...item,
              ...(groupTitle ? { compareGroup: groupTitle } : {}),
              ...(sideB ? { compareLabel: sideB } : {}),
              compareSide: "B",
            });
          }
          return merged;
        })
      : (rawItems as Array<Record<string, unknown>>);
  if (sources.length === 0) return [];

  const isVideo = toolName === "search_videos";
  const cards: MediaCardItem[] = [];
  // 硬上限 8：单 call 不再无限堆图，超过部分直接截断。
  // LLM 需要更多时应该拆成多个 query 并行搜，由 renderBlocks 自然交错。
  for (const it of sources.slice(0, 8)) {
    const title = String(it.title ?? "").trim();
    const thumbnailUrl = String(it.thumbnailUrl ?? "").trim();
    const mediaUrl = String(it.mediaUrl ?? "").trim();
    const pageUrl = String(it.pageUrl ?? "").trim();
    const source = String(it.source ?? "").trim();
    const width = Number(it.width);
    const height = Number(it.height);
    const groupTitle = String(it.compareGroup ?? "").trim();
    const sideRaw = String(it.compareSide ?? "").trim();
    const side = sideRaw === "A" || sideRaw === "B" ? sideRaw : undefined;
    const sideLabel = String(it.compareLabel ?? "").trim();
    // 可播流：enrichVideosWithPlayable 解析成功后写回 items 的 videoUrl。
    // 有流就必须下发——前端据此在应用内面板播放，而不是把用户丢去浏览器。
    const playableUrl = isVideo ? String(it.videoUrl ?? "").trim() : "";
    // 媒体卡片必须是"能看到图/能打开视频"的真实条目：
    // 若没有任何可加载的媒体地址（缩略图/媒体地址都为空），该条对用户无意义，
    // 直接丢弃，避免前端出现"占了位置但 thumbnailUrl 为空"的无效项。
    const hasMedia = !!(
      thumbnailUrl ||
      mediaUrl ||
      playableUrl ||
      (isVideo && pageUrl && /youtu|bilibili|video/i.test(pageUrl))
    );
    if (!hasMedia) continue;
    cards.push({
      type: isVideo ? "video" : "image",
      title: title || source || (isVideo ? "相关视频" : "图片结果"),
      // 视频只认真实缩略图（真实图片地址），绝不把播放页/搜索页 URL 当图下发；
      // 无真实缩略图时留空，前端显示视频占位图标 + 播放角标。图片则保持
      // 「本地 PNG 优先、其次媒体地址」的旧逻辑。
      thumbnailUrl: isVideo ? thumbnailUrl : thumbnailUrl || mediaUrl || "",
      mediaUrl: mediaUrl || undefined,
      ...(playableUrl ? { playableUrl: buildProxyMediaUrl(playableUrl, pageUrl) } : {}),
      pageUrl: pageUrl || undefined,
      source: source || undefined,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      ...(groupTitle ? { groupTitle } : {}),
      ...(side ? { side } : {}),
      ...(sideLabel ? { sideLabel } : {}),
    });
  }
  // 过滤：图片必须有缩略图；视频没有缩略图时只要有可打开的播放页也保留
  //（前端显示占位图标，点击仍可打开播放页），避免视频结果被整体丢弃。
  const kept = cards.filter(
    (c) => !!c.thumbnailUrl || (c.type === "video" && (!!c.pageUrl || !!c.playableUrl)),
  );
  // 视频卡排序：能播的排前面（稳定排序，组内保持原检索序）。
  // 否则用户点开列表前几条仍是「解析不出流只能跳站外」的条目——看着像坏掉了。
  if (!isVideo) return kept;
  return [
    ...kept.filter((c) => !!c.playableUrl),
    ...kept.filter((c) => !c.playableUrl),
  ];
}

/**
 * 媒体卡片去重（同一张图不重复展示）：按可展示地址（thumbnailUrl || mediaUrl）
 * 归一化去重，保留首次出现。多轮工具结果聚合时（search_images_batch 各维度、
 * 多次 search_images 调用）常出现相同图片被多次返回，这里统一收敛。
 */
export function dedupMediaCards(cards: MediaCardItem[]): MediaCardItem[] {
  const seen = new Set<string>();
  const out: MediaCardItem[] = [];
  for (const c of cards) {
    const key = (c.thumbnailUrl || c.mediaUrl || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export interface TrimMediaCardsOptions {
  /** 普通分组（空 groupTitle=单次搜索）最多保留张数，少而精 */
  maxPerGroup: number;
  /** 对比分组里 A/B 单侧各保留张数，保证两侧同时出现、不偏科 */
  maxPerSide: number;
}

/**
 * 主题粒度自适应裁剪：不设全局总量硬限，而是按主题(分组)保证"少而精、不遗漏"。
 *
 * 设计（2026-08-22）：用户反馈"抓回来的照片太多"，但硬砍全局总量会误伤多主题/
 * 对比场景——总量上限会优先保留前面主题、把后面主题或某一侧的图整个挤掉。这里
 * 改为按 groupTitle 分组裁剪：
 *   - 每个分组最多保留 maxPerGroup 张（普通单次搜索=单个空分组，天然少而精）；
 *   - 对比分组（带 compareSide A/B）每侧各保留 maxPerSide 张，两侧对称；
 *   - 不设全局总数上限：主题多则每个主题都保留（每组至少前几张），不因总量遗漏主题。
 * 返回去重、裁剪后的保序卡片列表。
 */
export function trimMediaCardsByTopic(
  cards: MediaCardItem[],
  opts: TrimMediaCardsOptions,
): MediaCardItem[] {
  const { maxPerGroup, maxPerSide } = opts;
  // 按 groupTitle 分组（空标题=普通单组搜索归入同一组），保留首次出现顺序
  const groups = new Map<string, MediaCardItem[]>();
  const order: string[] = [];
  for (const c of cards) {
    const key = (c.groupTitle ?? "").trim();
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
      order.push(key);
    }
    list.push(c);
  }
  const out: MediaCardItem[] = [];
  for (const key of order) {
    const list = groups.get(key)!;
    const isCompare = list.some((c) => c.side === "A" || c.side === "B");
    if (isCompare) {
      // 对比分组：每侧各保留 maxPerSide 张，缺 A/B 任一侧时该侧为空、不强行补
      const sideA = list.filter((c) => c.side === "A").slice(0, maxPerSide);
      const sideB = list.filter((c) => c.side === "B").slice(0, maxPerSide);
      out.push(...sideA, ...sideB);
    } else {
      // 普通分组：最多保留 maxPerGroup 张
      out.push(...list.slice(0, maxPerGroup));
    }
  }
  return out;
}

/** 安全地把未知值转成对象数组（flatMap 用）。 */
function asItems(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value as Array<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 交错渲染块（renderBlocks）：文字段落与媒体分组按正文顺序交错，替代"照片一次性铺在开头"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单个渲染块：纯文字段落 或 一组媒体卡片。
 *
 * 设计初衷（2026-08-20）：用户要求「需要照片时，一段文字介绍后放一张照片」，
 * 而不是把全部照片一次性铺在最前面。因此服务端在 `chat.assistant_done` 里
 * 额外下发 `renderBlocks`：把 LLM 正文按「分组关键词在正文中的出现位置」切成
 * 文字段，把对应媒体分组插到该文字段之后，前端按块顺序渲染即可得到
 * 「文字→照片→文字→照片」的自然阅读节奏。全程由代码确定性完成，不依赖 prompt。
 */
export type RenderBlock =
  | { type: "text"; text: string }
  | {
      type: "media";
      groupTitle?: string;
      sideA?: string;
      sideB?: string;
      cards: MediaCardItem[];
    };

/**
 * 把最终正文 + 媒体卡片列表构建成交错渲染块数组。
 *
 * 算法（位置锚定，代码层确定性）：
 * 1. 按 groupTitle 把 mediaCards 分成若干组（保留首次出现顺序）；单组无标题的
 *    普通图墙会先按正文段落数拆成「每簇 1 张」的子组（见 1.5 步）；
 * 2. 对每个分组，在正文中寻找「锚点」——精确命中（标题/两侧标签，含标题子串
 *    与同义词扩展）优先，未命中再用「标题 ↔ 句段」字符级 LCS 相似度做模糊锚定；
 * 3. 锚点吸附到所在句段开头，按位置升序切分正文：媒体块插在该段文字**之前**
 *    → 天然形成「一张照片 → 一段对它的简短介绍」的阅读节奏（2026-08-30 用户
 *    指定的一图一文顺序）；锚点不吞掉任何正文文字；
 * 4. 正文尾部残段作为最后一个 text 块；未命中任何锚点的分组追加到末尾兜底。
 *
 * @param finalText 最终回复正文（已剥离媒体标记后的干净文本）
 * @param mediaCards 结构化媒体卡片列表（含 groupTitle/side/sideLabel 元数据）
 * @returns 有序渲染块数组；无媒体时只返回一个 text 块（若正文非空）
 */

/**
 * 对比维度同义词表：分组维度标题在正文里用了同义/近义说法时扩大锚定命中面。
 * key=维度标题片段，value=正文里可能出现的同义说法。
 */
const DIMENSION_SYNONYMS: Record<string, string[]> = {
  持久度: ["持久", "持妆", "保持", "维持", "留色", "褪色", "坚持", "耐用"],
  价格: ["价钱", "售价", "价位", "多少钱", "便宜", "贵", "性价比", "花费"],
  色号: ["颜色", "色调", "色彩", "肤色", "涂上", "上色"],
  防水: ["防泼水", "防雨", "防汗", "防水性", "泼水", "不进水"],
  质地: ["质感", "肤感", "触感", "妆感", "细腻", "清爽"],
  包装: ["外观", "瓶身", "设计", "颜值", "容器", "外型"],
  效果: ["妆效", "上脸", "使用效果", "功效", "实际效果", "表现"],
  成分: ["配方", "成分表", "原料", "添加"],
  容量: ["含量", "规格", "大小", "尺寸", "毫升"],
  舒适度: ["舒适", "贴合", "柔软", "亲肤", "透气"],
};

/** 生成锚点候选词：标题精确词 + 全子串（覆盖「颜色持久度」→「持久」等拆词）+ 同义词。 */
function expandAnchorKeywords(title: string): string[] {
  const t = String(title ?? "").trim();
  if (t.length < 2) return [];
  const out = new Set<string>([t]);
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 2; j <= t.length && j - i <= 6; j++) {
      out.add(t.slice(i, j));
    }
  }
  for (const [dim, syns] of Object.entries(DIMENSION_SYNONYMS)) {
    if (t.includes(dim)) {
      for (const s of syns) out.add(s);
    }
  }
  return [...out].filter((k) => k.length >= 2);
}

/** 字符级最长公共子序列相似度（0~1），用于段落到分组的模糊匹配。 */
function lcsSimilarity(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[n][m] / Math.max(n, 1);
}

type TextSeg = { text: string; start: number };

/** 把正文按句子/段落切分，并记录每段在全文中的起始偏移。 */
function splitTextSegments(text: string): TextSeg[] {
  const out: TextSeg[] = [];
  const re = /[^。！？!?\n]+[。！？!?\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (trimmed.length < 2) continue;
    const start = text.indexOf(trimmed, m.index);
    out.push({ text: trimmed, start: start >= 0 ? start : m.index });
  }
  return out;
}

export function buildInterleavedRenderBlocks(
  finalText: string,
  mediaCards: MediaCardItem[],
): RenderBlock[] {
  if (mediaCards.length === 0) {
    const t = String(finalText ?? "").trim();
    return t ? [{ type: "text", text: t }] : [];
  }

  // 1) 按 groupTitle 分组（空标题=普通单组搜索，归入 "" 组）
  const groups: Array<{ title: string; cards: MediaCardItem[] }> = [];
  const idxByTitle = new Map<string, number>();
  for (const card of mediaCards) {
    const title = (card.groupTitle ?? "").trim();
    let gi = idxByTitle.get(title);
    if (gi === undefined) {
      gi = groups.length;
      groups.push({ title, cards: [] });
      idxByTitle.set(title, gi);
    }
    groups[gi].cards.push(card);
  }

  // 从分组构建媒体块（提取 sideA/sideB）：两处重复，提取为内联 lambda
  const makeMediaBlock = (g: { title: string; cards: MediaCardItem[] }): RenderBlock => {
    const sideA = g.cards.find((c) => c.side === "A")?.sideLabel;
    const sideB = g.cards.find((c) => c.side === "B")?.sideLabel;
    return {
      type: "media",
      ...(g.title ? { groupTitle: g.title } : {}),
      ...(sideA ? { sideA } : {}),
      ...(sideB ? { sideB } : {}),
      cards: g.cards,
    };
  };

  const text = String(finalText ?? "");

  // 1.5) 普适拆分：单 search_images（groupTitle 为空）一张大图墙 → 每张图独立成簇
  //
  // 背景：用户反馈「图片全堆在一起，不分段落交错」的根因是单次 search_images
  // 返回 N 张图全部进同一 "" group，renderBlocks 只能锚到一个位置 → 一大坨
  // 全堆在文本末尾。这里把「单组且组内 ≥2 张」的情况按正文段落数拆簇，
  // 且每簇只放 1 张图，配合「图在介绍段之前」的锚定（见第 2/2.5 步），
  // 形成「一张照片 → 一段对这张照片的简短介绍 → 下一张照片 → …」的节奏。
  //
  // 拆分原则：
  //   - 簇数 = min(正文段数, 图数)，图比段多时多余图片并入最后一簇；
  //   - 子组的 groupTitle 保持空（仍走普通图廊渲染），不伪造维度标题。
  const segmentsForSplit = splitTextSegments(text);
  if (
    groups.length === 1 &&
    groups[0].title === "" &&
    groups[0].cards.length >= 2 &&
    segmentsForSplit.length >= 1
  ) {
    const flat = groups[0].cards;
    const targetClusters = Math.min(segmentsForSplit.length, flat.length);
    if (targetClusters >= 2) {
      const split: Array<{ title: string; cards: MediaCardItem[] }> = [];
      // 前面各簇只放 1 张图（保证一图一段介绍），图比段多时多余图并入最后一簇
      for (let i = 0; i < targetClusters; i++) {
        const start = i;
        const end = i === targetClusters - 1 ? flat.length : start + 1;
        const slice = flat.slice(start, end);
        if (slice.length === 0) break;
        split.push({ title: "", cards: slice });
      }
      // 用拆分结果替换 groups，后续走原锚定逻辑
      groups.length = 0;
      groups.push(...split);
    }
  }

  // 2) 为每个分组计算锚点（锚定媒体组应插入的正文位置）
  //    策略（代码层确定性，不依赖 prompt）：
  //    a) 精确命中：分组标题/两侧标签（含标题子串与同义词）在正文的最早出现位置，
  //       吸附到所在句段的开头 —— 媒体块插在该段之前，形成
  //       「一张照片 → 一段对它的介绍」；end=pos，不吞掉任何正文文字；
  //    b) 模糊命中：无精确命中时，用「分组标题 ↔ 句段」的字符级 LCS 相似度，
  //       把媒体组锚定到最相关句段之前（覆盖换说法/意译场景）。
  type Anchor = { gi: number; pos: number; end: number };
  const anchors: Anchor[] = [];
  const segments = splitTextSegments(text);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // a) 精确 + 标题子串 + 同义词候选（标题）；两侧标签保持精确匹配
    const candidates = new Set<string>();
    if (g.title) {
      for (const k of expandAnchorKeywords(g.title)) candidates.add(k);
    }
    for (const c of g.cards) {
      const sl = (c.sideLabel ?? "").trim();
      if (sl.length >= 2) candidates.add(sl);
    }
    let best: Anchor | null = null;
    for (const kw of candidates) {
      const pos = text.indexOf(kw);
      if (pos >= 0 && (best === null || pos < best.pos)) {
        // 吸附到关键词所在句段开头：照片在该段介绍文字之前出现
        const host = segments.find((s) => pos >= s.start && pos < s.start + s.text.length);
        const anchorPos = host ? host.start : pos;
        best = { gi, pos: anchorPos, end: anchorPos };
      }
    }
    // b) 模糊命中：仅当没有精确命中且标题足够长时
    if (!best && g.title && g.title.length >= 2 && segments.length > 0) {
      let bestScore = 0;
      let bestSeg: TextSeg | null = null;
      for (const seg of segments) {
        const s = lcsSimilarity(g.title, seg.text);
        if (s > bestScore) {
          bestScore = s;
          bestSeg = seg;
        }
      }
      if (bestSeg && bestScore >= 0.5) {
        best = { gi, pos: bestSeg.start, end: bestSeg.start };
      }
    }
    if (best) anchors.push(best);
  }

  // 2.5) 兜底锚定：没有标题/两侧标签可命中的分组（典型：1.5 节拆分出来的空 title 子组）
  //       按数组顺序均匀分布到正文各句段**开头**：第 i 组的照片插在第
  //       floor(i * segCount / N) 段之前，紧跟着该段文字就是这组照片的介绍
  //       → 「一张照片 → 一段介绍 → 下一张照片」。pos=end=段首，
  //       正文文字一个字都不会被吞掉。
  const anchoredGis = new Set(anchors.map((a) => a.gi));
  if (segments.length > 0) {
    const titleLessGis: number[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      if (!anchoredGis.has(gi)) titleLessGis.push(gi);
    }
    if (titleLessGis.length > 0) {
      // 把 N 个无锚点组均匀分到 N 个句段：第 i 组 → 第 floor(i * segCount / N) 段首
      for (let i = 0; i < titleLessGis.length; i++) {
        const gi = titleLessGis[i];
        const segIdx = Math.min(
          segments.length - 1,
          Math.floor((i * segments.length) / titleLessGis.length),
        );
        const start = segments[segIdx].start;
        anchors.push({ gi, pos: start, end: start });
      }
    }
  }
  // 3) 锚点按位置升序
  anchors.sort((a, b) => a.pos - b.pos);
  const usedGis = new Set<number>();

  // 4) 切分正文并交错插入媒体块
  const blocks: RenderBlock[] = [];
  let cursor = 0;
  for (const anchor of anchors) {
    usedGis.add(anchor.gi);
    const seg = text.slice(cursor, anchor.pos).trim();
    if (seg) blocks.push({ type: "text", text: seg });
    blocks.push(makeMediaBlock(groups[anchor.gi]));
    cursor = Math.max(cursor, anchor.end);
  }
  const tail = text.slice(cursor).trim();
  if (tail) blocks.push({ type: "text", text: tail });

  // 5) 未命中锚点的分组追加到末尾兜底
  for (let gi = 0; gi < groups.length; gi++) {
    if (usedGis.has(gi)) continue;
    blocks.push(makeMediaBlock(groups[gi]));
  }

  return blocks;
}

/**
 * 有真实图片描述（caption）时的渲染块构建（Coze 式「一图一句」，2026-09-03）。
 *
 * 与 `buildInterleavedRenderBlocks` 的区别：caption 已经是对单张照片的准确描述
 * （视觉模型看图生成、随卡片下发、前端渲染在照片下方），正文不再需要被切成
 * 句段"钉"到照片旁边充当介绍——位置启发式切段正是此前「文字与照片对不上」
 * 的根源。因此这里：
 *   1. 正文作为整体一个 text 块（保持行结构，不切句、不锚定）；
 *   2. 照片按 groupTitle 分组（对比分组原样保留），每组一个 media 块跟在正文后，
 *      每张照片下方各带自己的 caption。
 *
 * 前端效果 = 扣子：一段回复正文 + 逐张「照片 + 对这张照片的一句描述」。
 *
 * @param finalText 清洗后的回复正文
 * @param mediaCards 已带 caption 的媒体卡片（全部图片卡都有 caption 时才应调用）
 */
export function buildCaptionedRenderBlocks(
  finalText: string,
  mediaCards: MediaCardItem[],
): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const text = String(finalText ?? "").trim();
  if (text) blocks.push({ type: "text", text });

  // 按 groupTitle 分组（空标题=普通单组，归入 "" 组），保留首次出现顺序
  const groups: Array<{ title: string; cards: MediaCardItem[] }> = [];
  const idxByTitle = new Map<string, number>();
  for (const card of mediaCards) {
    const title = (card.groupTitle ?? "").trim();
    let gi = idxByTitle.get(title);
    if (gi === undefined) {
      gi = groups.length;
      groups.push({ title, cards: [] });
      idxByTitle.set(title, gi);
    }
    groups[gi].cards.push(card);
  }
  for (const g of groups) {
    const sideA = g.cards.find((c) => c.side === "A")?.sideLabel;
    const sideB = g.cards.find((c) => c.side === "B")?.sideLabel;
    blocks.push({
      type: "media",
      ...(g.title ? { groupTitle: g.title } : {}),
      ...(sideA ? { sideA } : {}),
      ...(sideB ? { sideB } : {}),
      cards: g.cards,
    });
  }
  return blocks;
}

/** 判断媒体卡片里的图片卡是否全部带有非空 caption（决定走哪条渲染块路径）。 */
export function allImageCardsHaveCaption(cards: MediaCardItem[]): boolean {
  const imageCards = cards.filter((c) => c.type === "image");
  if (imageCards.length === 0) return false;
  return imageCards.every((c) => !!(c.caption ?? "").trim());
}

/**
 * 平铺图集：全部是图片卡、且没有对比分组元数据（单次 search_images 的普通结果）。
 *
 * 2026-10-21 根修（用户反馈「文字/表格穿插在照片中间」）：这类轮次只允许
 * 「一图一句」——照片按顺序铺开，每张下方是它自己的 caption；正文永远是一个
 * 整体块（放在图集前），不再按句切段钉到照片之间。此前 caption 缺失时回退到
 * buildInterleavedRenderBlocks 的切段交错排版，正文里的表格/新闻正好被塞进
 * 照片之间。caption 现在由独立视觉模型生成，缺 caption 也不会再改变版式。
 */
export function isFlatImageGallery(cards: MediaCardItem[]): boolean {
  if (cards.length === 0) return false;
  const images = cards.filter((c) => c.type === "image");
  if (images.length !== cards.length) return false;
  return cards.every(
    (c) => !(c.groupTitle ?? "").trim() && !(c.side ?? "").trim(),
  );
}