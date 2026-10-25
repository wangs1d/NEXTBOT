/**
 * 购物建议引擎（纯函数，无 LLM、无 IO）。
 *
 * runtime 集成形态：shopping.suggest 工具的 handler 调用本引擎，从自有
 * 商品库确定性产出结构化建议（候选 + 证据 + 转置对比表 + 媒体）；
 * 卡片由 tool-card-registry 从工具回执确定性构建，LLM 的口头回复只作
 * 前导正文（场景匹配在 LLM 拿到结构化数据后自然完成）。
 *
 * 搬去 Agent World 做生态功能时：本文件与 catalog/seeds/types 一起搬运，
 * 零宿主依赖。
 */

import type { ProductCatalog, ProductRecord } from "./product-catalog.js";

export type SuggestVideo = { title: string; url?: string; source?: string };

export type SuggestCandidate = {
  productId: string;
  brand: string;
  name: string;
  /** 参考价区间，如「¥1899–2249」 */
  priceLabel: string;
  image?: string;
  /** 渠道价明细（product_pick 卡的「去比价/去购买」CTA 数据源；种子库多为参考价无 url） */
  channels?: Array<{ name: string; priceCny: number; url?: string }>;
  reasons: string[];
  cautions: string[];
  videos: SuggestVideo[];
};

export type SuggestCompare = {
  dims: string[];
  /** 转置后的行：每行 = 维度 + 各候选取值（label 与 values 一一对应） */
  rows: Array<{ label: string; values: string[] }>;
};

/** 主推（立场核心：推谁 + 为什么是它） */
export type SuggestPick = {
  productId: string;
  /** 主推理由一句话，落到用户场景（个性化 LLM 产出；降级为商品库首条依据） */
  headline: string;
};

/** 备选的差异化定位（什么时候选它而不是主推） */
export type SuggestAlternative = {
  productId: string;
  whenChoose: string;
};

/** 真实口碑摘要（UGC，P3：归属主推商品，小红书聚合） */
export type SuggestUgcPost = { title: string; url?: string };
export type SuggestUgc = {
  platform: string;
  platformLabel: string;
  /** 命中帖子数（可信度展示） */
  mentions: number;
  /** 好评/避雷摘要（来自真实帖子标题，非编造；缺省=该桶无命中） */
  pros?: string[];
  cons?: string[];
  /** 来源帖子（卡上可点） */
  posts: SuggestUgcPost[];
};

export type SuggestResult = {
  query: string;
  summary: string;
  candidates: SuggestCandidate[];
  /** 立场：主推谁（candidates 排序后首位即主推，pick.headline 是给用户的理由） */
  pick?: SuggestPick;
  /** 备选定位（与 candidates[1..] 一一对应） */
  alternatives?: SuggestAlternative[];
  /** 聚合过程说明（溯源），透传到工具回执 */
  notes?: string[];
  /** 真实口碑摘要（P3 UGC：归属主推商品；聚合失败/空时缺省） */
  ugc?: SuggestUgc;
  compare?: SuggestCompare;
};

function shortName(p: ProductRecord): string {
  return `${p.brand} ${p.name}`.trim();
}

function priceLabelOf(p: ProductRecord): string {
  const min = Math.min(...p.channels.map((c) => c.priceCny));
  const max = Math.max(...p.channels.map((c) => c.priceCny));
  return min === max ? `¥${min}` : `¥${min}–${max}`;
}

function toCandidate(p: ProductRecord): SuggestCandidate {
  const review = p.reviewSummary;
  // 无口碑快照的商品：依据改用渠道价/在售渠道，不装作有口碑
  const hasReview = review.pros.length > 0 || review.sampleSize > 0;
  const reasons = hasReview
    ? [
        ...review.pros.slice(0, 2).map((x) => `口碑优点：${x}`),
        `适合：${review.suitedFor}`,
      ]
    : [
        `实时在售价 ${priceLabelOf(p)}`,
        ...(p.channels[0]?.name ? [`在售渠道：${p.channels[0].name}`] : []),
      ];
  const cautions = hasReview
    ? [
        ...review.cons.slice(0, 2).map((x) => `注意：${x}`),
        ...(review.avoidIf ? [`不适合：${review.avoidIf}`] : []),
      ]
    : [];
  return {
    productId: p.id,
    brand: p.brand,
    name: p.name,
    priceLabel: priceLabelOf(p),
    image: p.image,
    channels: p.channels.map((c) => ({
      name: c.name,
      priceCny: c.priceCny,
      ...(c.url ? { url: c.url } : {}),
    })),
    reasons,
    cautions,
    videos: p.media
      .filter((m) => m.type === "video")
      .map((m) => ({ title: m.title, url: m.url, source: m.source })),
  };
}

/** 转置对比表（维度为行、候选为列），过滤整行无数据的死维度 */
function buildCompare(products: ProductRecord[]): SuggestCompare {
  const cmp = products.length >= 2
    ? catalogCompare(products)
    : { dims: [] as string[], rows: [] as Array<{ label: string; values: string[] }> };
  const rows: SuggestCompare["rows"] = [];
  for (let i = 0; i < cmp.dims.length; i++) {
    const values = products.map((p) => {
      const spec = p.specs.find(
        (s) => s.label === cmp.dims[i] ||
          s.label.includes(cmp.dims[i]) ||
          cmp.dims[i].includes(s.label),
      );
      if (spec) return spec.value;
      if (cmp.dims[i] === "价格") return priceLabelOf(p);
      return "—";
    });
    if (values.some((v) => v !== "—")) {
      rows.push({ label: cmp.dims[i], values });
    }
  }
  return { dims: cmp.dims, rows };
}

function catalogCompare(products: ProductRecord[]): {
  dims: string[];
} {
  if (products.length < 2) return { dims: [] };
  const [first, ...rest] = products;
  const common = (first?.specs ?? [])
    .map((s) => s.label)
    .filter((label) => rest.every((p) => p.specs.some((s) => s.label === label)))
    .slice(0, 5);
  return { dims: [...common, "价格"] };
}

/**
 * 从商品库确定性构建购物建议。
 * - item 支持多关键词（如「XM5 Bose」），catalog.search 按命中计分；
 * - 候选 ≤ maxCandidates（默认 3）；≥2 时附转置对比表；
 * - 全部字段来自商品库（pros/cons/suitedFor/avoidIf/参数/渠道价），可溯源；
 * - 立场（pick/alternatives）为确定性降级形态：首位即主推。个性化 LLM
 *   可用时会重排并改写 headline/whenChoose（personalize.ts），本函数不依赖它。
 */
export function buildSuggestion(
  catalog: ProductCatalog,
  input: { item: string; budget?: number; maxCandidates?: number },
): SuggestResult | null {
  const found = catalog.search({
    query: input.item,
    budgetMax: input.budget,
    limit: input.maxCandidates ?? 3,
  });
  if (found.length === 0) return null;

  const candidates = found.map(toCandidate);
  const [first, ...rest] = candidates;
  const headline =
    first?.reasons[0] ?? `综合匹配度最高${first ? `（${first.priceLabel}）` : ""}`;
  return {
    query: input.item,
    summary:
      candidates.length === 1
        ? `商品库中「${input.item}」匹配到 ${candidates.length} 款：${shortName(found[0]!)}`
        : `商品库中「${input.item}」匹配到 ${candidates.length} 款，已并排对比`,
    candidates,
    pick: first
      ? { productId: first.productId, headline }
      : undefined,
    ...(rest.length > 0
      ? {
          alternatives: rest.map((c) => ({
            productId: c.productId,
            whenChoose: c.reasons[0] ?? "预算或偏好不同时的备选",
          })),
        }
      : {}),
    ...(candidates.length >= 2 ? { compare: buildCompare(found) } : {}),
  };
}
