/**
 * 盘点类场景（2026-11-09 三次收敛：只供事实，不接管正文）。
 *
 * ── 演进 ──────────────────────────────────────────────────────────
 * 第一版：让模型输出 `[AGENT_DIGEST_START]{...}` 槽位块。实测配合率不是 100%
 *   （漏标记甩裸 JSON / 自写加粗分组 / 干脆写散文），服务端为此写了裸 JSON
 *   扫描器、加粗归一化器、流式标记守卫——规则越加越多，全都在猜模型。
 * 第二版：不让模型输出结构，改由服务端从工具回执确定性渲染整段正文，
 *   模型只保留「语气散句」，出口整段替换（rewritesText）。
 * 第三版（当前，用户指令）：**正文交回模型**，一次生成；服务端只负责在
 *   生成前把本轮回执里的事实清单喂给它。理由：
 *     - 整段替换让正文与分泡分叉，收口逻辑复杂且容易和「已流式即定稿」冲突；
 *     - 语气散句+固定清单的拼接读起来是两个人写的；
 *     - 模型拿到干净的事实清单，本来就写得出清楚的回答，不需要服务端排版。
 *
 * 不变的一条：**清单条目只来自本轮工具回执**，模型不许自己造条目。
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
      // 同一条结果被多个工具重复带回时只留一份
      const key = `${title}|${detail.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, detail, source });
      if (out.length >= MAX_ITEMS) return out;
    }
  }
  return out;
}

/**
 * 把清单条目序列化成给模型看的事实行（纯数据，不含版式指令）。
 * 同一份 items 多次调用字节一致：不读时钟、不猜语义。
 */
export function renderRoundupFacts(items: RoundupItem[]): string {
  return items
    .map((item) => {
      const detail = item.detail && item.detail !== item.title ? ` — ${item.detail}` : "";
      return `- ${item.title}${detail}`;
    })
    .join("\n");
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
    singleBubble: true,
    promptBoundary: DIGEST_ROUNDUP_BOUNDARY,
  },
  contract:
    "清单条目唯一来源=本轮工具回执 items[]；条目以事实行注入 prompt，正文由模型一次写成，服务端不再排版或替换。",

  detect(ctx: SceneContext): SceneMatch | null {
    if (!isRoundupQuestion(ctx.userText)) return null;
    const items = collectRoundupItems(ctx);
    // 单条结果不需要清单化，交给常规正文，避免把单一事实硬拆成结构
    if (items.length < 2) return null;
    return { reason: `回执含 ${items.length} 条清单数据，作为事实注入 prompt` };
  },

  /** 生成前把条目喂给模型：这是本场景对回答的唯一贡献 */
  promptBoundaryFor(ctx: SceneContext): string | undefined {
    const items = collectRoundupItems(ctx);
    if (items.length < 2) return undefined;
    return `【本轮事实·清单条目】\n${renderRoundupFacts(items)}`;
  },

  plan(ctx, match) {
    const items = collectRoundupItems(ctx);
    if (items.length < 2) return null;
    return {
      sceneId: this.id,
      label: this.label,
      cards: [],
      bodyForm: "markdown",
      constraints: [
        "清单条目来自工具回执",
        "正文由模型自己组织，服务端不替换",
        "不得编造回执之外的条目",
      ],
      reason: match.reason,
    };
  },
};
