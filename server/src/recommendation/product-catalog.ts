/**
 * 产品目录存储：模块自有数据源，原子 JSON 落盘（data/recommendation/products.json）。
 *
 * 首次访问时用种子数据初始化；之后以磁盘为准（宿主/运营可手工编辑文件扩充）。
 * 刻意不依赖宿主的存储设施——搬去 Agent World 时只带这个目录即可。
 */

import { join } from "node:path";

import { SEED_PRODUCTS } from "./seed-products.js";
import { readJson, writeJson } from "./json-file.js";

export type ProductSpec = { label: string; value: string };

export type ProductChannel = {
  name: string;
  priceCny: number;
  url?: string;
};

export type ProductReviewSummary = {
  pros: string[];
  cons: string[];
  suitedFor: string;
  avoidIf: string;
  /** 评价样本量（编制期快照，UI 可展示可信度） */
  sampleSize: number;
  /** 评价聚合时间（epoch ms） */
  updatedAt: number;
};

export type ProductMedia = {
  type: "video" | "image";
  title: string;
  url: string;
  /** 来源平台（bilibili / official / …），sources 里如实透出 */
  source: string;
};

export type ProductRecord = {
  id: string;
  brand: string;
  name: string;
  category: string;
  tags: string[];
  desc: string;
  /** 商品主图 URL（相对路径走模块 media 端点，绝对 URL 直接外链） */
  image?: string;
  specs: ProductSpec[];
  channels: ProductChannel[];
  reviewSummary: ProductReviewSummary;
  media: ProductMedia[];
  seededAt: number;
};

export class ProductCatalog {
  private products: ProductRecord[];
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "products.json");
    const existing = readJson<ProductRecord[] | null>(this.path, null);
    if (existing && Array.isArray(existing) && existing.length > 0) {
      this.products = existing;
    } else {
      // 必须克隆：SEED_PRODUCTS 是模块级常量，直接引用会让多实例
      //（测试/多 dataDir）共享同一底层数组串数据
      this.products = JSON.parse(JSON.stringify(SEED_PRODUCTS)) as ProductRecord[];
      writeJson(this.path, this.products);
    }
  }

  list(): ProductRecord[] {
    return this.products;
  }

  get(productId: string): ProductRecord | undefined {
    return this.products.find((p) => p.id === productId);
  }

  /**
   * 关键词检索：name/brand/desc/tags/specs 命中计分，budgetMax 按最低渠道价过滤。
   * 返回按得分降序的前 limit 条；查询为空时返回空数组（不全量倒给模型省上下文）。
   */
  search(input: {
    query?: string;
    category?: string;
    budgetMax?: number;
    limit?: number;
  }): ProductRecord[] {
    const { query, category, budgetMax, limit = 5 } = input;
    const keywords = (query ?? "")
      .toLowerCase()
      .split(/[\s,，、/]+/)
      .filter((k) => k.length > 0);

    const scored = this.products
      .map((p) => {
        if (category && p.category !== category) return { p, score: -1 };
        const minPrice = Math.min(...p.channels.map((c) => c.priceCny));
        if (typeof budgetMax === "number" && budgetMax > 0 && minPrice > budgetMax * 1.15) {
          // 预算外 15% 弹性内仍保留（模型可拿来做「加点预算」建议）
          return { p, score: -1 };
        }
        if (keywords.length === 0) return { p, score: 1 };
        // 字段加权：名称/品牌/标签是强信号（+3），描述/参数是弱信号（+1）——
        // 防止「Mac/Win 双系统」这类参数文本误命中品牌词「MAC」
        const strong = [p.name, p.brand, ...p.tags].join(" ").toLowerCase();
        const weak = [
          p.category,
          p.desc,
          ...p.specs.map((s) => `${s.label}${s.value}`),
        ]
          .join(" ")
          .toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (strong.includes(kw)) score += 3;
          else if (weak.includes(kw)) score += 1;
          else if (kw.length >= 3 && strong.includes(kw.slice(0, 3))) score += 1;
        }
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      // 弱候选裁剪：低于最高分一半的不再进推荐（对比场景避免凑数款）
      .filter((x, _i, arr) => x.score >= arr[0]!.score * 0.5);

    return scored.map((x) => x.p);
  }

  /** 结构化对比：按 dims 维度对齐（参数表精确匹配 label，找不到填 "—"） */
  compare(productIds: string[], dims?: string[]): {
    products: ProductRecord[];
    dims: string[];
    rows: Array<{ productId: string; values: string[] }>;
  } {
    const products = productIds
      .map((id) => this.get(id))
      .filter((p): p is ProductRecord => Boolean(p));
    const dimList =
      dims && dims.length > 0
        ? dims
        : this.inferCommonDims(products);
    const rows = products.map((p) => ({
      productId: p.id,
      values: dimList.map((dim) => {
        const spec = p.specs.find(
          (s) => s.label === dim || s.label.includes(dim) || dim.includes(s.label),
        );
        if (spec) return spec.value;
        if (dim === "价格") return `最低 ¥${Math.min(...p.channels.map((c) => c.priceCny))}`;
        return "—";
      }),
    }));
    return { products, dims: dimList, rows };
  }

  /** 未指定 dims 时取参数交集 + 价格（保证表格至少两列） */
  private inferCommonDims(products: ProductRecord[]): string[] {
    if (products.length === 0) return [];
    const [first, ...rest] = products;
    const common = (first?.specs ?? [])
      .map((s) => s.label)
      .filter((label) =>
        rest.every((p) => p.specs.some((s) => s.label === label)),
      )
      .slice(0, 4);
    return [...common, "价格"];
  }

}
