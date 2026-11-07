/**
 * 结构卡场景（Tier B：模型只填槽，契约由服务端校验）。
 *
 * 模型在正文里写 [AGENT_RESULT_CARD_START]{...}[AGENT_RESULT_CARD_END]。
 * 客户端会直接渲染这个载荷，所以**坏块绝不能被放行**：
 *   - JSON 解析失败 / cardType 不在白名单 / items 为空或超量 / 条目缺 text
 *     → 整块剥掉，正文按 markdown 兜底（用户看到的是完整散文，不是裸 JSON）；
 *   - 通过校验 → 原样保留，卡片即交付（正文只作前导）。
 *
 * 校验只认字段，不认版式：模型不需要知道卡片长什么样。
 */

import type { RenderScene, SceneContext, SceneMatch } from "./types.js";
import { RESULT_CARD_TYPES } from "./prompts.js";

const CARD_BLOCK_RE =
  /\[AGENT_RESULT_CARD_START\]\s*([\s\S]*?)\s*\[AGENT_RESULT_CARD_END\]/g;

const ITEM_TYPES = new Set(["num", "warn", "link", "text"]);
const MAX_ITEMS = 12;

export interface ResultCardIssue {
  index: number;
  reason: string;
}

export interface ResultCardAudit {
  total: number;
  valid: Array<Record<string, unknown>>;
  issues: ResultCardIssue[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function validateCard(card: unknown): string | null {
  if (!isPlainObject(card)) return "载荷不是对象";
  const cardType = typeof card.cardType === "string" ? card.cardType : "";
  if (!cardType) return "缺少 cardType";
  if (!RESULT_CARD_TYPES.includes(cardType)) return `cardType 不在白名单：${cardType}`;
  if (typeof card.title !== "string" || !card.title.trim()) return "缺少 title";
  if (!Array.isArray(card.items) || card.items.length === 0) return "items 为空";
  if (card.items.length > MAX_ITEMS) return `items 超量（${card.items.length}）`;
  for (const [i, item] of card.items.entries()) {
    if (!isPlainObject(item)) return `第 ${i + 1} 条不是对象`;
    if (typeof item.text !== "string" || !item.text.trim()) return `第 ${i + 1} 条缺少 text`;
    if (item.type !== undefined && !ITEM_TYPES.has(String(item.type))) {
      return `第 ${i + 1} 条 type 非法：${String(item.type)}`;
    }
  }
  return null;
}

/** 审计正文里的全部结构卡块（不改文本） */
export function auditResultCards(text: string): ResultCardAudit {
  const audit: ResultCardAudit = { total: 0, valid: [], issues: [] };
  const re = new RegExp(CARD_BLOCK_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    audit.total += 1;
    const index = audit.total - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      audit.issues.push({ index, reason: "JSON 解析失败" });
      continue;
    }
    const problem = validateCard(parsed);
    if (problem) {
      audit.issues.push({ index, reason: problem });
      continue;
    }
    audit.valid.push(parsed as Record<string, unknown>);
  }
  return audit;
}

/** 剥掉全部结构卡块（坏块清理；保留其余正文） */
export function stripResultCardBlocks(text: string): string {
  return text.replace(new RegExp(CARD_BLOCK_RE.source, "g"), "").replace(/\n{3,}/g, "\n\n").trim();
}

function hasAnyCardBlock(text: string): boolean {
  return new RegExp(CARD_BLOCK_RE.source).test(text);
}

export const resultCardScene: RenderScene = {
  id: "result_card",
  label: "结构卡",
  priority: 60,
  // detect 依赖模型写在正文里的卡块 → 只能在出口运行（P3 时序守卫）
  phase: "post",
  produces: { cardTypes: [...RESULT_CARD_TYPES] },
  contract: "cardType 白名单 + items 1–12 + 每条 text 非空；不合格整块剥掉走 markdown。",

  detect(ctx: SceneContext): SceneMatch | null {
    if (!hasAnyCardBlock(ctx.text ?? "")) return null;
    const audit = auditResultCards(ctx.text ?? "");
    return {
      reason: audit.issues.length > 0
        ? `${audit.total} 张卡，${audit.issues.length} 张不合格`
        : `${audit.total} 张卡全部通过契约`,
    };
  },

  plan(ctx, match) {
    const audit = auditResultCards(ctx.text ?? "");
    if (audit.issues.length === 0) {
      return {
        sceneId: this.id,
        label: this.label,
        cards: [],
        constraints: ["卡即交付", "正文不复述条目"],
        reason: match.reason,
      };
    }
    return {
      sceneId: this.id,
      label: this.label,
      cards: [],
      bodyForm: "markdown",
      text: stripResultCardBlocks(ctx.text ?? ""),
      constraints: ["坏卡已剥离", "正文按 markdown 兜底"],
      reason: `${match.reason}（${audit.issues.map((i) => `#${i.index + 1} ${i.reason}`).join("；")}）`,
    };
  },
};
