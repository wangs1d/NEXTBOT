/**
 * 盘点类场景（2026-11-05 二次根改：数据面直供，不要求模型配合）。
 *
 * ── 为什么要推倒重来 ────────────────────────────────────────────────
 * 上一版让模型输出 `[AGENT_DIGEST_START]{...}[AGENT_DIGEST_END]` 槽位块，
 * 实测真实模型配合率不是 100%：有时漏标记甩裸 JSON，有时自写 `**加粗**` 分组，
 * 有时干脆写散文。为了兜住这三种偏差，服务端被迫写了裸 JSON 扫描器、
 * 加粗分组归一化器、流式标记守卫——**规则越加越多，而且全都在猜模型**。
 *
 * 根源诊断：「让模型输出机器可读结构」本身就不可靠，任何依赖它配合的
 * 契约都只是概率方案。真正的解法是**不让模型输出结构**：
 *
 *   结构数据 = 本轮工具回执（search_web / fetch_web 的 items[]），由服务端确定性渲染
 *   模型产出 = 只剩语气层（开场句、判断、收尾），不写任何标记/标题/列表/JSON
 *
 * 于是：
 *   - 配合率问题消失（不要求模型配合任何格式，模型怎么写都不影响版式）
 *   - 裸 JSON / 标记泄漏问题消失（模型没有理由写 JSON，prompt 里也没有契约）
 *   - 同一份回执 → 逐字节一致的版式
 *   - 模型仍提供内容与语气，符合「agent 只给内容+语气，其余由程序层组装」
 *
 * 代价（如实记录）：语义主题分组（「新片 / 维权 / 活动」）需要模型的分类判断，
 * 现在换成固定的「要点」清单。信息完整性与版式确定性优先于分组粒度。
 */

import { DIGEST_ROUNDUP_BOUNDARY } from "./prompts.js";
import type { RenderScene, SceneContext, SceneMatch } from "./types.js";

/** 盘点类提问的措辞特征（仅用于决定是否启用本场景，不约束模型输出） */
const ROUNDUP_INTENT =
  /最近|近期|近况|动态|盘点|汇总|都发生了什么|有什么新|进展|消息|新闻|这几件事|情况/;

/** 会带 items[] 的检索类工具；工具名是唯一判据，不猜回执内容 */
const ROUNDUP_TOOLS = new Set([
  "search_web",
  "fetch_web",
  "news.search",
  "news.latest",
]);

const MAX_ITEMS = 12;
const MAX_TITLE_LEN = 60;
const MAX_SNIPPET_LEN = 180;
const MAX_TONE_SENTENCES = 2;
const MAX_TONE_LEN = 240;

export interface RoundupItem {
  title: string;
  detail: string;
  source: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cleanText(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  const text = v.replace(/\s*\n+\s*/g, " ").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen).trim()}…` : text;
}

/**
 * 从本轮真实工具执行里抽取清单条目。
 * 只看成功回执里的 items[]；失败/空回执一律不产内容（与卡片场景同一底线）。
 */
export function collectRoundupItems(ctx: SceneContext): RoundupItem[] {
  // tool-result-processor 已把直跑回执规范化成 effects（与 loop 捕获同形），
  // 这里只认这一份列表，不另开 toolName/toolResult 的第二数据源。
  const effects = ctx.effects ?? [];

  const out: RoundupItem[] = [];
  const seen = new Set<string>();
  for (const effect of effects) {
    if (effect.status !== "ok" || !ROUNDUP_TOOLS.has(effect.tool)) continue;
    const result = effect.result;
    if (!isPlainObject(result) || !Array.isArray(result.items)) continue;
    for (const raw of result.items) {
      if (!isPlainObject(raw)) continue;
      const title = cleanText(raw.title, MAX_TITLE_LEN);
      const detail = cleanText(raw.snippet ?? raw.content ?? raw.summary, MAX_SNIPPET_LEN);
      const source = cleanText(raw.source, 24) || effect.tool;
      if (!title) continue;
      // 同一条结果被多个工具重复带回时不重复渲染
      const key = `${title}|${detail.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, detail, source });
      if (out.length >= MAX_ITEMS) return out;
    }
  }
  return out;
}

/** 确定性渲染：同一份 items 多次调用字节一致，不读时钟、不猜语义 */
export function renderRoundupMarkdown(items: RoundupItem[]): string {
  const lines = items.map((item) => {
    const detail = item.detail && item.detail !== item.title ? ` — ${item.detail}` : "";
    return `- ${item.title}${detail}`;
  });
  return [`**要点**`, ...lines].join("\n");
}

/** 结构化痕迹：标题、加粗、列表、引用、标记、JSON、表格、分隔线、编号 */
const STRUCTURAL_LINE_RE =
  /^\s*(?:#{1,6}\s|\*\*|[-*•]\s|>\s|\[[A-Z_]+\]|\{.*\}\s*$|\|.*\|\s*$|-{3,}\s*$|\d+[.、]\s)/;

/** 把句子和回执都切成字 bigram，重合率高就是复述（清单里已有，不必再说一遍） */
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s\p{P}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function isRestatement(sentence: string, items: RoundupItem[]): boolean {
  const grams = bigrams(sentence);
  if (grams.size < 6) return false;
  for (const item of items) {
    const source = bigrams(`${item.title}${item.detail}`);
    let hit = 0;
    for (const g of grams) if (source.has(g)) hit += 1;
    if (hit / grams.size >= 0.3) return true;
  }
  return false;
}

/** 模型正文里剥出「语气层」：只留判断/开场散句，事实复述与自写版式一律剔除 */
export function extractToneSentences(text: string, items: RoundupItem[]): string[] {
  const candidates = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !STRUCTURAL_LINE_RE.test(l));

  const sentences: string[] = [];
  for (const line of candidates) {
    for (const piece of line.split(/(?<=[。！？!?])\s*/)) {
      const s = piece.trim();
      if (!s || STRUCTURAL_LINE_RE.test(s)) continue;
      if (isRestatement(s, items)) continue;
      if (sentences.includes(s)) continue;
      sentences.push(s);
      if (sentences.length >= MAX_TONE_SENTENCES) break;
    }
    if (sentences.length >= MAX_TONE_SENTENCES) break;
  }
  // 总长度硬上限：语气层是点缀，不能反过来盖过结构化清单
  const kept: string[] = [];
  let used = 0;
  for (const s of sentences) {
    if (used + s.length > MAX_TONE_LEN) break;
    kept.push(s);
    used += s.length;
  }
  return kept;
}

/** 开场句放清单前、其余放清单后（顺序确定性，不做语义猜测） */
function assemble(items: RoundupItem[], tone: string[]): string {
  const rendered = renderRoundupMarkdown(items);
  const lead = tone.slice(0, 1).join(" ");
  const tail = tone.slice(1).join(" ");
  return [lead, rendered, tail].filter(Boolean).join("\n\n");
}

function isRoundupQuestion(userText?: string): boolean {
  return ROUNDUP_INTENT.test(userText ?? "");
}

export const digestRoundupScene: RenderScene = {
  id: "digest_roundup",
  label: "盘点清单",
  priority: 50,
  phase: "pre",
  produces: {
    forms: ["structured"],
    rewritesText: true,
    promptBoundary: DIGEST_ROUNDUP_BOUNDARY,
  },
  contract:
    "结构数据唯一来源=工具回执 items[]；模型只写语气散句，不输出任何标记/JSON/版式。版式由服务端确定性渲染。",

  detect(ctx: SceneContext): SceneMatch | null {
    if (!isRoundupQuestion(ctx.userText)) return null;
    const items = collectRoundupItems(ctx);
    // 单条结果不需要清单化，交给常规正文，避免把单一事实硬拆成结构
    if (items.length < 2) return null;
    return { reason: `回执含 ${items.length} 条清单数据，版式由服务端产出（不依赖模型）` };
  },

  plan(ctx, match) {
    const items = collectRoundupItems(ctx);
    if (items.length < 2) return null;
    const tone = extractToneSentences(ctx.text ?? "", items);
    return {
      sceneId: this.id,
      label: this.label,
      cards: [],
      bodyForm: "markdown",
      text: assemble(items, tone),
      constraints: [
        "清单来自工具回执",
        "模型不写标题层级/JSON",
        "模型正文只保留语气散句",
      ],
      reason: match.reason,
    };
  },
};
