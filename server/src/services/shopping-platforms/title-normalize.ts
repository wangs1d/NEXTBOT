/**
 * 商品标题归一化与同款判定（从 shopping-compare-service 抽出，比价线与
 * 比价与推荐线共用。
 */

/** 营销词与噪音段（归一化时剔除） */
const MARKETING_NOISE_RE =
  /(【[^】]*】|\[[^\]]*\]|（[^）]*?(包邮|顺丰|现货|正品|礼盒|装)[^）]*?\）|\([^)]*?(包邮|顺丰|现货|正品)[^)]*\))/g;
const MARKETING_WORDS_RE =
  /(正品|包邮|顺丰|现货|官方|旗舰店|自营|全新|正品保障|限时|特价|秒杀|热卖|爆款|新品|新款|促销|直降|立减|20\d{2}年?款?)/g;

/** 规格 token：容量/克重/数量/尺寸/型号（同款判定的硬依据） */
const SPEC_TOKEN_RE =
  /(\d+(?:\.\d+)?)\s*(ml|l|升|毫升|g|克|kg|千克|斤|两|瓦|w|英寸|寸|mah|ah|支|包|袋|瓶|箱|盒|片|粒|抽|卷|双|套)|([a-z]{1,5}\d{2,5}[a-z]?)(?=\b)/gi;

/** 标题归一化：去营销噪音/符号/空白，小写 */
export function normalizeTitle(raw: string): string {
  let t = String(raw ?? "").toLowerCase();
  t = t.replace(MARKETING_NOISE_RE, " ");
  t = t.replace(MARKETING_WORDS_RE, " ");
  t = t.replace(/[^\p{L}\p{N}.%]+/gu, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** 提取规格 token（小写归一；型号 token 与数量规格合并去重） */
export function extractSpecTokens(raw: string): string[] {
  const t = String(raw ?? "").toLowerCase();
  const out = new Set<string>();
  for (const m of t.matchAll(SPEC_TOKEN_RE)) {
    if (m[1] !== undefined && m[2] !== undefined) out.add(`${m[1]}${m[2]}`);
    else if (m[3]) out.add(m[3]);
  }
  return [...out];
}

/** Dice 二元组相似度（中文短文本归一化标题比较） */
export function diceSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a).replace(/\s+/g, "");
  const nb = normalizeTitle(b).replace(/\s+/g, "");
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const grams = new Set<string>();
  for (let i = 0; i < na.length - 1; i++) grams.add(na.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const g = nb.slice(i, i + 2);
    if (grams.has(g)) hit += 1;
  }
  return (2 * hit) / (na.length - 1 + nb.length - 1);
}
